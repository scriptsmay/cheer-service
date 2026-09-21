'use strict';

/**
 * kpl-source — kpl-data-daily 采集产物的数据源抽象
 *
 * 背景：采集与 git 备份已迁至 txyun 宿主机 systemd timer（业务分离），
 * 本服务只负责「读产物 → 入库」。产物有两种取法：
 *
 * - local : 读宿主机只读挂载目录（KPL_DATA_DIR）——历史行为，默认值
 * - github: 读 GitHub raw（采集端 git-backup 会把 data/ 推回仓库）——
 *           摆脱宿主机挂载依赖，供免费云迁移使用
 *
 * 切换：`KPL_SOURCE=local|github`（默认 local，可一键回退）。
 * 变更检测：local 用「文件 mtime vs 上次同步时间戳」；github 用「条件请求
 * （If-None-Match）拿 304」，无 mtime 可用。
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('../config/env');

const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com/scriptsmay/kpl_data_daily/main';
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 归一化同步状态：老版本状态文件是纯数字时间戳字符串（Date.now()），
 * 新版本是 JSON。两者都要能读，避免升级后误判为「首次同步」。
 * @param {string|object|null} raw
 * @returns {{timestampMs: number, etags: Record<string, string|null>}}
 */
function normalizeState(raw) {
  if (raw && typeof raw === 'object') {
    return {
      timestampMs: Number.isFinite(raw.timestampMs) ? raw.timestampMs : 0,
      etags: raw.etags && typeof raw.etags === 'object' ? { ...raw.etags } : {},
    };
  }
  const parsed = parseInt(String(raw ?? '').trim(), 10);
  return { timestampMs: Number.isFinite(parsed) ? parsed : 0, etags: {} };
}

/**
 * 创建数据源实例（带依赖注入，便于单测）
 *
 * @param {object} [options]
 * @param {string} [options.source]     local | github
 * @param {string} [options.localDir]   本地挂载目录
 * @param {string} [options.rawBase]    GitHub raw 基址
 * @param {number} [options.timeoutMs]  单次请求超时
 * @param {number} [options.retries]    失败重试次数
 * @param {Function} [options.fetchImpl] fetch 实现（测试注入）
 * @param {object} [options.logger]     日志器
 */
function createKplSource(options = {}) {
  const source = String(options.source || config.kplSource || 'local').toLowerCase();
  if (source !== 'local' && source !== 'github') {
    throw new Error(`KPL_SOURCE 取值非法: ${source}（仅支持 local | github）`);
  }

  const localDir = options.localDir || config.kplDataDir;
  const rawBase = String(options.rawBase || config.kplGithubRawBase || DEFAULT_RAW_BASE)
    .replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs || config.kplFetchTimeoutMs;
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const log = options.logger || console;

  /** 需要参与变更检测的产物文件（与业务分离前的 mtime 检测范围一致） */
  function trackedFiles(season) {
    return [
      path.join('data', 'derived', season, 'overview.json'),
      path.join('data', 'derived', season, 'schedule.json'),
    ];
  }

  /** GitHub raw 请求（含重试）；失败抛错，由调用方兜底 */
  async function githubRequest(relPath, headers = {}) {
    const url = `${rawBase}/${relPath.split(path.sep).join('/')}`;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /**
   * 读取产物文本；读不到返回 null（与分离前的 fetchData 语义一致）
   * @param {string} relPath
   * @returns {Promise<string|null>}
   */
  async function readText(relPath) {
    if (source === 'local') {
      const fullPath = path.join(localDir, relPath);
      try {
        return await fs.readFile(fullPath, 'utf8');
      } catch (e) {
        log.error(`[kpl-source] 本地读取失败: ${fullPath} - ${e.message}`);
        return null;
      }
    }

    try {
      const res = await githubRequest(relPath);
      if (res.status === 404) {
        log.warn(`[kpl-source] GitHub 无此文件(404): ${relPath}`);
        return null;
      }
      if (!res.ok) {
        log.error(`[kpl-source] GitHub 读取失败: ${relPath} - HTTP ${res.status}`);
        return null;
      }
      return await res.text();
    } catch (e) {
      log.error(`[kpl-source] GitHub 读取异常: ${relPath} - ${e.message}`);
      return null;
    }
  }

  /**
   * 读取并解析 JSON；任一步失败返回 null
   * @param {string} relPath
   * @returns {Promise<object|null>}
   */
  async function readKplJson(relPath) {
    const raw = await readText(relPath);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      log.error(`[kpl-source] JSON 解析失败: ${relPath} - ${e.message}`);
      return null;
    }
  }

  /** 溯源串，写入 sync_snapshots.source */
  function describeSource(relPath) {
    if (source === 'local') return `local:${path.join(localDir, relPath)}`;
    return `github:${rawBase}/${relPath.split(path.sep).join('/')}`;
  }

  /**
   * 是否相对上次同步有变更
   *
   * local 模式：比对 tracked 文件 mtime 与上次同步时间戳（stat 失败时保守视为有变更）
   * github 模式：条件请求，304 = 未变化；无历史 ETag 或拿到新 ETag = 有变更
   *
   * @param {string} season
   * @param {string|object|null} prevState 同步状态（兼容旧版纯时间戳）
   * @returns {Promise<{changed: boolean, state: object}>}
   */
  async function checkChanged(season, prevState) {
    const state = normalizeState(prevState);
    const nextState = { ...state, timestampMs: Date.now() };

    if (source === 'local') {
      for (const rel of trackedFiles(season)) {
        try {
          const stats = await fs.stat(path.join(localDir, rel));
          if (stats.mtimeMs > state.timestampMs) {
            log.log(`[kpl-source] 变更: ${rel} (mtime ${stats.mtimeMs} > 上次同步 ${state.timestampMs})`);
            return { changed: true, state: nextState };
          }
        } catch (e) {
          if (e.code !== 'ENOENT') {
            log.warn(`[kpl-source] stat ${rel} 失败（保守视为有变更）: ${e.message}`);
            return { changed: true, state: nextState };
          }
          // 文件尚不存在属正常（赛季刚切换、派生数据未生成），跳过
        }
      }
      return { changed: false, state };
    }

    let changed = false;
    const etags = { ...state.etags };
    for (const rel of trackedFiles(season)) {
      const prevEtag = etags[rel] || null;
      try {
        const res = await githubRequest(rel, prevEtag ? { 'If-None-Match': prevEtag } : {});
        if (res.status === 304) continue;
        if (res.status === 404) {
          log.warn(`[kpl-source] 变更检测: GitHub 无此文件(404) ${rel}`);
          continue;
        }
        if (!res.ok) {
          log.warn(`[kpl-source] 变更检测失败（保守视为有变更）: ${rel} - HTTP ${res.status}`);
          changed = true;
          continue;
        }
        const etag = res.headers.get('etag');
        if (!prevEtag || etag !== prevEtag) changed = true;
        etags[rel] = etag;
      } catch (e) {
        log.warn(`[kpl-source] 变更检测异常（保守视为有变更）: ${rel} - ${e.message}`);
        changed = true;
      }
    }
    return { changed, state: { ...nextState, etags } };
  }

  return { mode: source, readText, readKplJson, checkChanged, describeSource, trackedFiles };
}

let defaultInstance = null;

/** 默认单例（读环境变量，首次调用时创建） */
function getDefaultSource() {
  if (!defaultInstance) defaultInstance = createKplSource();
  return defaultInstance;
}

module.exports = {
  createKplSource,
  normalizeState,
  readText: (relPath) => getDefaultSource().readText(relPath),
  readKplJson: (relPath) => getDefaultSource().readKplJson(relPath),
  checkChanged: (season, prevState) => getDefaultSource().checkChanged(season, prevState),
  describeSource: (relPath) => getDefaultSource().describeSource(relPath),
  getMode: () => getDefaultSource().mode,
};
