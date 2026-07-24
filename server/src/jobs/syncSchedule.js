'use strict';

/**
 * syncSchedule job
 * 每日 06:00，从本地 kpl-data-daily 数据目录全量同步赛程
 */

const fs = require('fs');
const path = require('path');
const { collection } = require('../db/mongo');
const { mergeScheduleMatches, recordSyncSnapshot } = require('../lib/schedule-merge');

const KPL_DATA_DIR = process.env.KPL_DATA_DIR || '/app/kpl-data-daily';

async function syncSchedule() {
  const result = { season: null, status: 'pending', matches: 0, error: null };

  try {
    // 1. 读取赛季元信息
    const seasonRaw = await fetchData('data/latest/current-season.json');
    if (!seasonRaw) {
      result.status = 'error';
      result.error = 'current-season.json not found';
      await recordSyncSnapshot({ type: 'schedule', season: null, status: 'error', error: result.error });
      return result;
    }
    const seasonMeta = JSON.parse(seasonRaw);
    const season = seasonMeta.current || seasonMeta.season;
    result.season = season;

    // 2. 读取赛程文件
    const scheduleRaw = await fetchData(`data/derived/${season}/schedule.json`);
    if (!scheduleRaw) {
      result.status = 'skipped';
      result.error = 'schedule.json not found';
      await recordSyncSnapshot({ type: 'schedule', season, status: 'skipped', error: result.error });
      return result;
    }
    const schedule = JSON.parse(scheduleRaw);
    const matches = schedule.matches || [];
    result.matches = matches.length;

    if (matches.length === 0) {
      result.status = 'skipped';
      result.error = 'schedule.json has no matches';
      await recordSyncSnapshot({ type: 'schedule', season, status: 'skipped', error: result.error });
      return result;
    }

    const seasonName = schedule.season_name || season;
    for (const m of matches) { if (!m.season_name) m.season_name = seasonName; }

    const sourceFetchedAt = schedule.updated_at || new Date().toISOString();
    const mergeResult = await mergeScheduleMatches(season, matches, {
      isFullSync: true, isLive: false, sourceFetchedAt,
      sourceStatus: schedule.source_status || 'ok', maxRetries: 3,
    });

    result.status = mergeResult.action === 'skipped' ? 'skipped' : mergeResult.action === 'no_change' ? 'no_change' : 'success';
    result.matched_count = mergeResult.matchedCount;
    result.changed_count = mergeResult.changedCount;
    result.revision = mergeResult.revision;
    result.fallback_used = mergeResult.fallbackUsed || false;

    await recordSyncSnapshot({
      type: 'schedule', season, status: result.status,
      matchedCount: mergeResult.matchedCount, changedCount: mergeResult.changedCount,
      sourceFetchedAt, error: result.fallback_used ? 'fallback merge key used' : null,
    });
  } catch (err) {
    console.error('[sync-schedule] Error:', err.message, err.stack);
    result.status = 'error';
    result.error = err.message;
    try {
      await recordSyncSnapshot({ type: 'schedule', season: result.season || 'unknown', status: 'error', error: err.message });
    } catch (_) {}
  }

  return result;
}

async function fetchData(relPath) {
  const fullPath = path.join(KPL_DATA_DIR, relPath);
  console.log(`[sync-schedule] Reading: ${fullPath}`);
  try {
    return fs.readFileSync(fullPath, 'utf-8');
  } catch (e) {
    console.error(`[sync-schedule] Read failed: ${fullPath} - ${e.message}`);
    return null;
  }
}

module.exports = { syncSchedule };
