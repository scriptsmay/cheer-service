'use strict';

/**
 * syncKplCrawl — KPL 数据同步编排（变更检测 → 同步入库 → 状态戳更新）
 *
 * 数据流程（业务分离架构）:
 * 1. txyun 宿主机 systemd timer 执行 Python 爬虫并 git push 备份（kpl-data-daily 仓库）
 * 2. 本任务（容器内）只读挂载宿主机数据目录，检测数据文件变更后同步到 MongoDB
 *
 * 容器内无爬虫、无 git、无第三方 API 调用；采集节奏由宿主机 systemd timer 管理，
 * 本任务的 cron 只决定同步检查时机（固定每天 09:00，见 schedules.js）。
 */

const fs = require('fs').promises;
const path = require('path');
const { syncData } = require('./syncData');
const { syncSchedule } = require('./syncSchedule');

const KPL_DATA_DIR = process.env.KPL_DATA_DIR || '/app/kpl-data-daily';
// 同步状态戳落点：挂载目录归宿主机所有（只读），状态必须写在容器可写卷 /app/data
const SYNC_STATE_FILE = process.env.KPL_SYNC_STATE_FILE || '/app/data/.kpl_last_sync';

/**
 * 读取当前赛季标识（data/latest/current-season.json 的 current 字段）
 * @returns {Promise<string|null>} 不可读时返回 null（视为无数据可同步）
 */
async function readCurrentSeason() {
  try {
    const raw = await fs.readFile(path.join(KPL_DATA_DIR, 'data', 'latest', 'current-season.json'), 'utf8');
    const meta = JSON.parse(raw);
    return meta.current || meta.season || null;
  } catch {
    return null;
  }
}

/**
 * 对比数据文件 mtime 与上次同步状态戳，判断是否有新数据
 * 状态戳缺失视为首次同步（有变更）；stat 出错时保守视为有变更
 * （宁可多同步一次，syncData/syncSchedule 幂等）
 * @param {string} season - 当前赛季标识
 * @returns {Promise<boolean>}
 */
async function hasDataChanged(season) {
  let lastSyncMs = 0;
  try {
    const raw = await fs.readFile(SYNC_STATE_FILE, 'utf8');
    const parsed = parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed)) lastSyncMs = parsed;
  } catch {
    // 首次同步，无状态戳
  }

  for (const rel of [
    path.join('data', 'derived', season, 'overview.json'),
    path.join('data', 'derived', season, 'schedule.json'),
  ]) {
    try {
      const stats = await fs.stat(path.join(KPL_DATA_DIR, rel));
      if (stats.mtimeMs > lastSyncMs) {
        console.log(`[syncKplCrawl] Changed: ${rel} (mtime ${stats.mtimeMs} > last sync ${lastSyncMs})`);
        return true;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[syncKplCrawl] stat ${rel} failed:`, err.message);
        return true;
      }
      // 文件尚不存在属正常（如赛季刚切换、派生数据未生成），跳过该文件
    }
  }
  return false;
}

/**
 * 主同步任务 — 检测挂载目录数据变更，有变更则依次执行 syncData + syncSchedule
 *
 * 两者全部成功才更新状态戳；有失败保留旧戳，等待下个窗口自动重试
 * （syncData/syncSchedule 自行从 KPL_DATA_DIR 读取正确路径，本函数不传内容只编排）
 *
 * @returns {Promise<{hasChanges: boolean, synced: boolean, season?: string, errors?: string[]}>}
 */
async function syncKplCrawl() {
  const result = { hasChanges: false, synced: false };
  console.log(`[syncKplCrawl] Checking data changes in ${KPL_DATA_DIR}`);

  const season = await readCurrentSeason();
  if (!season) {
    console.warn('[syncKplCrawl] current-season.json not readable, nothing to sync');
    return result;
  }
  result.season = season;

  result.hasChanges = await hasDataChanged(season);
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
    await fs.writeFile(SYNC_STATE_FILE, Date.now().toString());
    result.synced = true;
    console.log('[syncKplCrawl] Sync completed, state updated');
  } else {
    console.warn('[syncKplCrawl] Sync finished with errors, state NOT updated (will retry next run)');
  }

  return result;
}

module.exports = { syncKplCrawl };
