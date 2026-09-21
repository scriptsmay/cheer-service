'use strict';

/**
 * syncKplCrawl — KPL 数据同步编排（变更检测 → 同步入库 → 状态戳更新）
 *
 * 数据流程（业务分离架构）:
 * 1. txyun 宿主机 systemd timer 执行 Python 爬虫并 git push 备份（kpl-data-daily 仓库）
 * 2. 本任务读取采集产物（kpl-source：local 挂载目录 / github raw），检测变更后同步入库
 *
 * 容器内无爬虫、无 git、无第三方 API 调用；采集节奏由宿主机 systemd timer 管理，
 * 本任务的 cron 只决定同步检查时机（固定每天 09:00，见 schedules.js）。
 */

const { collection } = require('../db');
const { syncData } = require('./syncData');
const { syncSchedule } = require('./syncSchedule');
const kplSource = require('../lib/kpl-source');

// 变更检测状态戳落点：app_config 文档（Vercel serverless 除 /tmp 外文件系统只读且
// 实例冷启即失，容器卷路径不可用）；存进库后多宿主共用一份基线。
const STATE_COLLECTION = 'app_config';
const STATE_DOC = 'kpl_sync_state';

// 进程内互斥：手动触发与 cron 同跑一个实例时，后到者直接跳过而非并发写同一批表
let inFlight = false;

/**
 * 读取上次同步状态（文档不存在时返回 null，视为首次同步）
 * @returns {Promise<object|string|null>}
 */
async function readSyncState() {
  try {
    const col = await collection(STATE_COLLECTION);
    const result = await col.doc(STATE_DOC).get();
    const doc = result.data && result.data[0];
    return doc ? doc.state ?? doc : null;
  } catch (e) {
    console.warn(`[syncKplCrawl] 读取同步状态失败（按首次同步处理）: ${e.message}`);
    return null;
  }
}

/**
 * 写入同步状态戳
 * @param {object} state kpl-source checkChanged 返回的 state
 */
async function writeSyncState(state) {
  const col = await collection(STATE_COLLECTION);
  await col.doc(STATE_DOC).set({
    state,
    updated_at: new Date().toISOString(),
  });
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
 * @returns {Promise<{hasChanges: boolean, synced: boolean, season?: string, skipped?: string, errors?: string[]}>}
 */
async function syncKplCrawl() {
  if (inFlight) {
    console.warn('[syncKplCrawl] 已有同步在执行，本次跳过');
    return { hasChanges: false, synced: false, skipped: 'in-flight' };
  }
  inFlight = true;
  try {
    return await runSync();
  } finally {
    inFlight = false;
  }
}

async function runSync() {
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
    try {
      await writeSyncState(changeCheck.state);
      result.synced = true;
      console.log('[syncKplCrawl] Sync completed, state updated');
    } catch (e) {
      // 数据已入库，仅状态戳未落——计入错误避免被当成完全成功，下个窗口自动重试
      console.error('[syncKplCrawl] sync state write failed:', e.message);
      result.errors.push(`syncState: ${e.message}`);
    }
  } else {
    console.warn('[syncKplCrawl] Sync finished with errors, state NOT updated (will retry next run)');
  }

  return result;
}

/** 是否已有同步在跑（手动触发接口据此拒绝重复提交） */
function isSyncRunning() {
  return inFlight;
}

module.exports = { syncKplCrawl, isSyncRunning };
