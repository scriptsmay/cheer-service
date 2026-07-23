'use strict';

/**
 * syncScheduleLive job — ← sync-schedule-live
 * 每 10 分钟，仅在比赛窗口内增量同步 KPL 赛程
 */

const { collection } = require('../db/mongo');
const { computeWindowStatus, fetchKplScheduleList, convertKplMatches, mergeScheduleMatches, recordSyncSnapshot } = require('../lib/schedule-merge');

async function syncScheduleLive() {
  const result = { status: 'pending', window_active: false, matched_count: 0, changed_count: 0, error: null };

  try {
    const col = await collection('match_schedules');
    const existing = await col.orderBy('updated_at', 'desc').limit(1).get();

    if (existing.data.length === 0) {
      result.status = 'skipped';
      result.error = 'no match_schedules document';
      return result;
    }

    const doc = existing.data[0];
    const seasonId = doc.season_id;
    const matches = doc.matches || [];

    const windowStatus = computeWindowStatus(matches);
    result.window_active = windowStatus.window_active;
    result.computed_at = windowStatus.computed_at;

    if (!windowStatus.window_active) {
      result.status = 'skipped';
      result.reason = 'window_not_active';
      return result;
    }

    let rawMatches;
    try {
      rawMatches = await fetchKplScheduleList(seasonId, 15000);
    } catch (apiErr) {
      result.status = 'error';
      result.error = `KPL API: ${apiErr.message}`;
      await recordSyncSnapshot({ type: 'schedule-live', season: seasonId, status: 'error', windowActive: true, error: apiErr.message });
      return result;
    }

    if (!Array.isArray(rawMatches) || rawMatches.length === 0) {
      result.status = 'skipped';
      result.error = 'KPL API empty list';
      await recordSyncSnapshot({ type: 'schedule-live', season: seasonId, status: 'skipped', windowActive: true, error: 'KPL API empty list' });
      return result;
    }

    const sourceFetchedAt = new Date().toISOString();
    const { matches: ksgMatches } = convertKplMatches(rawMatches, seasonId);

    const mergeResult = await mergeScheduleMatches(seasonId, ksgMatches, {
      isFullSync: false, isLive: true, sourceFetchedAt, sourceStatus: 'ok', maxRetries: 3,
    });

    result.status = mergeResult.action === 'no_change' ? 'no_change' : 'success';
    result.matched_count = mergeResult.matchedCount;
    result.changed_count = mergeResult.changedCount;
    result.revision = mergeResult.revision;
    result.fallback_used = mergeResult.fallbackUsed || false;

    await recordSyncSnapshot({
      type: 'schedule-live', season: seasonId, status: result.status,
      matchedCount: mergeResult.matchedCount, changedCount: mergeResult.changedCount,
      windowActive: true, sourceFetchedAt,
      error: result.fallback_used ? 'fallback merge key used' : null,
    });
  } catch (err) {
    console.error(`[sync-schedule-live] Error: ${err.message}`);
    result.status = 'error';
    result.error = err.message;
    try {
      await recordSyncSnapshot({ type: 'schedule-live', season: 'unknown', status: 'error', windowActive: result.window_active, error: err.message });
    } catch (_) {}
  }

  return result;
}

module.exports = { syncScheduleLive };
