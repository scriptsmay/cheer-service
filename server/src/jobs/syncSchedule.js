'use strict';

/**
 * syncSchedule job — 全量同步赛程（采集产物 → MongoDB）
 * 由 syncKplCrawl 编排调用（每日 09:00 定时窗口 / 后台手动同步），不独立调度
 *
 * 数据来源由 kpl-source 抽象：local（宿主机挂载目录）或 github（GitHub raw）。
 */

const { collection } = require('../db');
const { mergeScheduleMatches, recordSyncSnapshot } = require('../lib/schedule-merge');
const kplSource = require('../lib/kpl-source');

async function syncSchedule() {
  const result = { season: null, status: 'pending', matches: 0, error: null };

  try {
    // 1. 读取赛季元信息
    const seasonMeta = await kplSource.readKplJson('data/latest/current-season.json');
    if (!seasonMeta) {
      result.status = 'error';
      result.error = 'current-season.json not found';
      await recordSyncSnapshot({ type: 'schedule', season: null, status: 'error', error: result.error });
      return result;
    }
    const season = seasonMeta.current || seasonMeta.season;
    result.season = season;

    // 2. 读取赛程文件
    const schedule = await kplSource.readKplJson(`data/derived/${season}/schedule.json`);
    if (!schedule) {
      result.status = 'skipped';
      result.error = 'schedule.json not found';
      await recordSyncSnapshot({ type: 'schedule', season, status: 'skipped', error: result.error });
      return result;
    }
    const data = schedule.data || schedule;
    const matches = data.matches || [];
    result.matches = matches.length;

    if (matches.length === 0) {
      result.status = 'skipped';
      result.error = 'schedule.json has no matches';
      await recordSyncSnapshot({ type: 'schedule', season, status: 'skipped', error: result.error });
      return result;
    }

    const seasonName = data.season_name || season;
    for (const m of matches) { if (!m.season_name) m.season_name = seasonName; }

    const sourceFetchedAt = data.updated_at || new Date().toISOString();
    const mergeResult = await mergeScheduleMatches(season, matches, {
      isFullSync: true, isLive: false, sourceFetchedAt,
      sourceStatus: data.source_status || 'ok', maxRetries: 3,
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

module.exports = { syncSchedule };
