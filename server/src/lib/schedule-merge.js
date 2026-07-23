/**
 * schedule-merge — 赛程窗口计算与事务合并公共逻辑
 *
 * 从 functions/lib/schedule-merge.js 移植，适配 MongoDB 兼容层
 * 由 sync-schedule、sync-schedule-live、get-schedule 共用
 */

const { collection, runTransaction, isTransactionConflict } = require('../db/mongo');

// ---- 窗口计算 ----

function isMatchInWindow(match, now) {
  if (!match || !match.start_ts) return false;
  const nowTs = Math.floor(now.getTime() / 1000);
  const startTs = match.start_ts;
  const bo = match.bo || 5;
  const expectedSec = (bo >= 7 ? 5 : 4) * 3600;
  const windowStart = startTs - 30 * 60;
  const windowEnd = startTs + expectedSec + 90 * 60;
  return nowTs >= windowStart && nowTs <= windowEnd;
}

function computeWindowStatus(matches, now = new Date()) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return { window_active: false, active_count: 0, computed_at: now.toISOString() };
  }
  const activeCount = matches.filter((m) => isMatchInWindow(m, now)).length;
  return {
    window_active: activeCount > 0,
    active_count: activeCount,
    computed_at: now.toISOString(),
  };
}

// ---- KPL API ----

const KPL_API_BASE = 'https://kplshop-op.timi-esports.qq.com/kplow';
const TEAM_KEYWORD = 'KSG';

async function fetchKplScheduleList(seasonId, timeout = 15000) {
  const url = new URL(`${KPL_API_BASE}/getScheduleList`);
  const payload = JSON.stringify({ season_id: seasonId });

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    body: payload,
    signal: AbortSignal.timeout(timeout),
  });

  const data = await response.json();
  const list = data?.data?.list;
  if (!Array.isArray(list)) {
    throw new Error(`KPL API returned non-list: status=${response.status}`);
  }
  return list;
}

function convertKplMatches(rawMatches, _seasonId) {
  const allMatches = rawMatches.map((m) => {
    const status = normalizeKplScheduleStatus(m.schedule_status);
    const teamA = m.team_a_name || '';
    const teamB = m.team_b_name || '';
    const match = {
      schedule_id: String(m.scheduleid || ''),
      start_ts: parseInt(m.start_timestamp, 10) || 0,
      date: tsToBeijingDate(m.start_timestamp),
      team_a: teamA,
      team_b: teamB,
      is_ksg: teamA.includes(TEAM_KEYWORD) || teamB.includes(TEAM_KEYWORD),
      location: m.location_name || '',
      stage: m.stage_name || '',
      bo: parseInt(m.bo_total, 10) || 5,
      status,
    };
    if (status >= 2) {
      match.score_a = parseInt(m.team_a_score, 10) || 0;
      match.score_b = parseInt(m.team_b_score, 10) || 0;
    }
    return match;
  });

  const ksgMatches = allMatches.filter((m) => m.is_ksg);
  ksgMatches.sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));

  console.log(`[schedule-merge] KPL fetch: ${allMatches.length} total, ${ksgMatches.length} KSG matches`);
  return { matches: ksgMatches, allCount: allMatches.length, ksgCount: ksgMatches.length };
}

function normalizeKplScheduleStatus(rawStatus) {
  const raw = parseInt(rawStatus, 10);
  if (raw === 3) return 2;
  if (raw === 4) return 4;
  if (raw === 1) return 1;
  return 1;
}

function tsToBeijingDate(tsStr) {
  try {
    const ts = parseInt(tsStr, 10);
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const mm = String(bj.getMonth() + 1).padStart(2, '0');
    const dd = String(bj.getDate()).padStart(2, '0');
    const hh = String(bj.getHours()).padStart(2, '0');
    const min = String(bj.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${min}`;
  } catch (_) {
    return '';
  }
}

// ---- 事务合并（适配 MongoDB 兼容层） ----

function findMatchIndex(matches, update) {
  if (update.schedule_id) {
    const idx = matches.findIndex((m) => m.schedule_id && m.schedule_id === update.schedule_id);
    if (idx >= 0) return { index: idx, key: 'schedule_id' };
  }
  if (update.start_ts && update.team_a && update.team_b) {
    const idx = matches.findIndex(
      (m) => !m.schedule_id && m.start_ts === update.start_ts && m.team_a === update.team_a && m.team_b === update.team_b
    );
    if (idx >= 0) return { index: idx, key: 'fallback' };
  }
  return { index: -1, key: null };
}

const UPDATABLE_FIELDS = ['start_ts', 'date', 'status', 'score_a', 'score_b', 'stage', 'location', 'bo'];

async function mergeScheduleMatches(seasonId, updates, opts = {}) {
  const { isFullSync = false, sourceFetchedAt = null, sourceStatus = 'ok', isLive = false, maxRetries = 3 } = opts;

  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await runTransaction(async (tc) => {
        const existing = await tc('match_schedules').where({ season_id: seasonId }).get();

        if (existing.data.length === 0) {
          const doc = {
            season_id: seasonId,
            season_name: updates.length > 0 ? updates[0].season_name || seasonId : seasonId,
            team_id: '',
            matches: updates.sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0)),
            revision: 1,
            updated_at: new Date().toISOString(),
            source_fetched_at: sourceFetchedAt || new Date().toISOString(),
            source_status: sourceStatus,
          };
          if (isLive) doc.last_live_synced_at = new Date().toISOString();
          await tc('match_schedules').add(doc);
          return { action: 'created', matchedCount: updates.length, changedCount: updates.length, revision: 1, fallbackUsed: false };
        }

        const doc = existing.data[0];
        const currentRevision = doc.revision || 0;
        const matches = Array.from(doc.matches || []);

        if (isFullSync && sourceFetchedAt && doc.source_fetched_at) {
          if (new Date(sourceFetchedAt) <= new Date(doc.source_fetched_at)) {
            return { action: 'skipped', reason: 'source_not_newer', matchedCount: 0, changedCount: 0, revision: currentRevision, fallbackUsed: false };
          }
        }

        let matchedCount = 0, changedCount = 0, fallbackUsed = false;

        for (const update of updates) {
          const { index, key } = findMatchIndex(matches, update);
          if (key === 'fallback') fallbackUsed = true;

          if (index >= 0) {
            matchedCount++;
            let changed = false;
            for (const field of UPDATABLE_FIELDS) {
              if (update[field] !== undefined && update[field] !== matches[index][field]) {
                matches[index][field] = update[field];
                changed = true;
              }
            }
            if (update.schedule_id && !matches[index].schedule_id) {
              matches[index].schedule_id = update.schedule_id;
              changed = true;
            }
            if (changed) changedCount++;
          } else if (isFullSync) {
            matches.push(update);
            matchedCount++;
            changedCount++;
          }
        }

        matches.sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));

        const updateData = { matches, revision: currentRevision + 1, updated_at: new Date().toISOString() };
        if (sourceFetchedAt) updateData.source_fetched_at = sourceFetchedAt;
        if (sourceStatus) updateData.source_status = sourceStatus;
        if (isLive && changedCount > 0) updateData.last_live_synced_at = new Date().toISOString();

        await tc('match_schedules').doc(doc._id).update(updateData);

        return { action: changedCount > 0 ? 'updated' : 'no_change', matchedCount, changedCount, revision: currentRevision + 1, fallbackUsed };
      });

      if (result.fallbackUsed) console.warn(`[schedule-merge] Fallback merge key used for season=${seasonId}`);
      return result;
    } catch (err) {
      lastError = err;
      if (isTransactionConflict(err) && attempt < maxRetries - 1) {
        console.warn(`[schedule-merge] Transaction conflict (attempt ${attempt + 1}/${maxRetries}), retrying...`);
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('mergeScheduleMatches: max retries exceeded');
}

// ---- 快照记录 ----

async function recordSyncSnapshot(snap) {
  const doc = {
    season: snap.season || 'unknown',
    type: snap.type || 'schedule',
    status: snap.status || 'ok',
    matched_count: snap.matchedCount ?? 0,
    changed_count: snap.changedCount ?? 0,
    window_active: snap.windowActive ?? false,
    source_fetched_at: snap.sourceFetchedAt || null,
    error: snap.error || null,
    updated_at: new Date().toISOString(),
  };
  try {
    const col = await collection('sync_snapshots');
    await col.add(doc);
  } catch (e) {
    console.error(`[schedule-merge] Failed to record snapshot: ${e.message}`);
  }
}

module.exports = {
  isMatchInWindow,
  computeWindowStatus,
  fetchKplScheduleList,
  convertKplMatches,
  normalizeKplScheduleStatus,
  mergeScheduleMatches,
  recordSyncSnapshot,
  isTransactionConflict,
  UPDATABLE_FIELDS,
};
