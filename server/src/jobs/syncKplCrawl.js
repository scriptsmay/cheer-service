'use strict';

/**
 * syncKplCrawl — KPL 数据同步编排（变更检测 → 同步入库 → 状态戳更新）
 *
 * 数据流程（业务分离架构）:
 * 1. txyun 宿主机 systemd timer 执行 Python 爬虫并 git push 备份（kpl-data-daily 仓库）
 * 2. 本任务读取采集产物（kpl-source：local 挂载目录 / github raw），检测变更后同步 MongoDB
 *
 * 容器内无爬虫、无 git、无第三方 API 调用；采集节奏由宿主机 systemd timer 管理，
 * 本任务的 cron 只决定同步检查时机（固定每天 09:00，见 schedules.js）。
 */

const fs = require('fs').promises;
const { syncData } = require('./syncData');
const { syncSchedule } = require('./syncSchedule');
const kplSource = require('../lib/kpl-source');

// 同步状态戳落点：挂载目录归宿主机所有（只读），状态必须写在容器可写卷 /app/data
const SYNC_STATE_FILE = process.env.KPL_SYNC_STATE_FILE || '/app/data/.kpl_last_sync';

/**
 * 读取上次同步状态（JSON；兼容旧版纯时间戳文件），文件不存在时返回 null
 * @returns {Promise<object|string|null>}
 */
async function readSyncState() {
  try {
    const raw = await fs.readFile(SYNC_STATE_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * 读取当前赛季标识（data/latest/current-season.json 的 current 字段）
 * @returns {Promise<string|null>} 不可读时返回 null（视为无数据可同步）
 */
async function readCurrentSeason() {
  const meta = await kplSource.readKplJson('data/latest/current-season.json');
  if (!meta) return null;
  return meta.current || meta.season || null;
}

/**
 * 主同步任务 — 检测采集产物变更，有变更则依次执行 syncData + syncSchedule
 *
 * 变更检测与产物读取都由 kpl-source 抽象（local 挂载目录 / github raw）；
 * 两者全部成功才更新状态，有失败保留旧状态，等待下个窗口自动重试
 *
 * @returns {Promise<{hasChanges: boolean, synced: boolean, season?: string, errors?: string[]}>}
 */
async function syncKplCrawl() {
  const result = { hasChanges: false, synced: false };
  console.log(`[syncKplCrawl] Checking data changes (source: ${kplSource.getMode()})`);

  const season = await readCurrentSeason();
  if (!season) {
    console.warn('[syncKplCrawl] current-season.json not readable, nothing to sync');
    return result;
  }
  result.season = season;

  const prevState = await readSyncState();
  const changeCheck = await kplSource.checkChanged(season, prevState);
  result.hasChanges = changeCheck.changed;
  if (!result.hasChanges) {
    console.log('[syncKplCrawl] No data changes, skipping sync');
    return result;
  }

  result.errors = [];

  try {
    await syncData();
  } catch (e) {
    console.error('[syncKplCrawl] syncData error:', e.message);
    result.errors.push(`syncData: ${e.message}`);
  }

  try {
    await syncSchedule();
  } catch (e) {
    console.error('[syncKplCrawl] syncSchedule error:', e.message);
    result.errors.push(`syncSchedule: ${e.message}`);
  }

  if (result.errors.length === 0) {
    await fs.writeFile(SYNC_STATE_FILE, JSON.stringify(changeCheck.state));
    result.synced = true;
    console.log('[syncKplCrawl] Sync completed, state updated');
  } else {
    console.warn('[syncKplCrawl] Sync finished with errors, state NOT updated (will retry next run)');
  }

  return result;
}

module.exports = { syncKplCrawl };
