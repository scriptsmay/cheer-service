'use strict';

/**
 * syncData job
 * 每日 04:00，从本地 kpl-data-daily 数据目录读取赛季概览写入 MongoDB
 */

const fs = require('fs');
const path = require('path');
const { collection } = require('../db/mongo');
const crypto = require('crypto');

const KPL_DATA_DIR = process.env.KPL_DATA_DIR || '/app/kpl-data-daily';

async function syncData() {
  const results = { season: null, synced: [], skipped: [], errors: [] };

  try {
    // 1. 读取当前赛季
    const seasonRaw = await fetchData('data/latest/current-season.json');
    if (!seasonRaw) {
      results.errors.push('current-season.json not found');
      return results;
    }
    const seasonMeta = JSON.parse(seasonRaw);
    const season = seasonMeta.current || seasonMeta.season;
    results.season = season;
    console.log(`[sync] Current season: ${season}`);

    // 2. 读取 overview.json
    const overviewRaw = await fetchData(`data/derived/${season}/overview.json`);
    if (!overviewRaw) {
      console.warn(`[sync] overview.json not found for ${season}`);
      results.skipped.push('overview.json');
      return results;
    }
    const overview = JSON.parse(overviewRaw);
    const playerInfo = overview.data && overview.data.player_info ? overview.data.player_info : overview;
    console.log(`[sync] Overview loaded: ${playerInfo.latest_nickname} - ${season}`);

    // 3. 防御：从 hero_stats 重新计算 hero_top
    if (overview.data && overview.data.hero_stats) {
      const heroTop = overview.data.hero_stats.map((h) => ({
        hero_name: h.hero_name, battles: h.battles, win_rate: h.win_rate,
      }));
      overview.hero_top = heroTop;
    }

    // 4. Upsert season_summaries
    const summaryDoc = {
      season,
      season_name: overview.data?.career_summary?.last_season_id || season,
      player_name: playerInfo.latest_nickname || 'unknown',
      team_name: playerInfo.latest_team || 'unknown',
      data: overview,
      updated_at: new Date().toISOString(),
    };
    const col = await collection('season_summaries');
    const existing = await col.where({ season }).get();
    if (existing.data.length > 0) {
      await col.doc(existing.data[0]._id).update(summaryDoc);
    } else {
      await col.add(summaryDoc);
    }
    results.synced.push('season_summaries');

    // 5. 写入每日赛季快照
    const today = new Date().toISOString().split('T')[0];
    const metrics = extractMetrics(overview, season);
    const overviewHash = md5(JSON.stringify(metrics));
    const snapshotDoc = { date: today, season_id: season, overview_hash: overviewHash, metrics, created_at: new Date().toISOString() };
    const snapCol = await collection('season_snapshots');
    const snapExisting = await snapCol.where({ date: today, season_id: season }).get();
    if (snapExisting.data.length > 0) {
      await snapCol.doc(snapExisting.data[0]._id).update(snapshotDoc);
    } else {
      await snapCol.add(snapshotDoc);
    }
    results.synced.push('season_snapshots');

    // 6. 清理 90 天前的旧快照
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    try {
      const oldSnaps = await snapCol.where({ date: { $lte: cutoffDate } }).get();
      for (const s of oldSnaps.data) {
        await snapCol.doc(s._id).remove();
      }
      console.log(`[sync] season_snapshots cleaned: ${oldSnaps.data.length} records before ${cutoffDate}`);
    } catch (e) { console.warn(`[sync] season_snapshots cleanup skipped: ${e.message}`); }

    // 7. 记录同步快照
    const syncCol = await collection('sync_snapshots');
    await syncCol.add({
      season, type: 'daily', status: 'success',
      source: `local:data/derived/${season}/overview.json`,
      updated_at: new Date().toISOString(),
    });
    results.synced.push('sync_snapshots');
    console.log('[sync] Done');
  } catch (err) {
    console.error('[sync] Error:', err.message, err.stack);
    results.errors.push(err.message);
    try {
      const col = await collection('sync_snapshots');
      await col.add({ season: results.season || 'unknown', type: 'daily', status: 'error', error: err.message, updated_at: new Date().toISOString() });
    } catch (_) {}
  }

  return results;
}

async function fetchData(relPath) {
  const fullPath = path.join(KPL_DATA_DIR, relPath);
  console.log(`[sync] Reading: ${fullPath}`);
  try {
    return fs.readFileSync(fullPath, 'utf-8');
  } catch (e) {
    console.error(`[sync] Read failed: ${fullPath} - ${e.message}`);
    return null;
  }
}

function extractMetrics(overview, seasonId) {
  const data = overview.data || overview;
  const summary = data.career_summary || {};
  const seasonStats = Array.isArray(data.season_stats) ? data.season_stats : [];
  const season = seasonStats.find((s) => s.season_id === seasonId) || data.current_season || {};
  return {
    win_rate: season.win_rate ?? summary.win_rate ?? 0,
    kda_ratio: season.kda_ratio ?? summary.kda_ratio ?? 0,
    battles: season.battles ?? summary.total_matches ?? 0,
    mvp: season.mvp ?? summary.mvp_count ?? 0,
    wins: season.wins ?? 0, loses: season.loses ?? 0,
    avg_kills: season.avg_kills ?? 0, avg_deaths: season.avg_deaths ?? 0, avg_assists: season.avg_assists ?? 0,
  };
}

function md5(str) { return crypto.createHash('md5').update(str).digest('hex'); }

module.exports = { syncData };
