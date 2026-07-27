'use strict';

/**
 * /api/admin — 运维管理（需登录）+ 数据同步（API Key）
 *
 * GET  /api/admin              — 管理页面 (HTML，含登录表单)
 * GET  /api/admin/ai/config    — 查看当前 AI 配置（脱敏）[需登录]
 * PUT  /api/admin/ai/config    — 更新 AI 配置（持久化到 /app/data/ai-config.json）[需登录]
 * POST /api/admin/ai/test      — 测试 AI 连通性 [需登录]
 * POST /api/admin/sync/overview — 接收赛季概览数据（kpl-data-daily 推送）[API Key]
 * POST /api/admin/sync/schedule — 接收赛程数据（kpl-data-daily 推送）[API Key]
 */

const express = require('express');
const router = express.Router();
const { getEffectiveConfig, saveConfig } = require('../services/ai-config');
const { collection } = require('../db/mongo');
const config = require('../config/env');
const crypto = require('crypto');

// kpl-data-daily 手动采集（容器内 Python 爬虫）+ 入库
let syncKplCrawl, syncData, syncSchedule;
try { syncKplCrawl = require('../jobs/syncKplCrawl').syncKplCrawl; } catch (_) {}
try { syncData = require('../jobs/syncData').syncData; } catch (_) {}
try { syncSchedule = require('../jobs/syncSchedule').syncSchedule; } catch (_) {}
const { getScheduleList } = require('../jobs/schedules');

// ── 鉴权守卫：硬拦截（仅允许 JWT 登录用户，拒绝匿名/旧版 Token）──
function requireAuth(req, res, next) {
  if (req.identity && req.identity.ok && req.identity.kind === 'session') return next();
  return res.status(401).json({ code: 'UNAUTHORIZED', message: '请先登录' });
}

// ── 数据同步鉴权（API Key）──
function requireSyncKey(req, res, next) {
  const key = req.headers['x-sync-key'] || '';
  if (config.syncApiKey && key === config.syncApiKey) return next();
  return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid sync key' });
}

// ── 辅助函数 ──
function md5(str) { return crypto.createHash('md5').update(str).digest('hex'); }

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

// ═══════════════════════════════════════════════
// 数据同步接口（API Key 鉴权）
// ═══════════════════════════════════════════════

// POST /api/admin/sync/overview — 接收赛季概览数据并写入 MongoDB
router.post('/sync/overview', requireSyncKey, async (req, res) => {
  try {
    const { season, overview } = req.body;
    if (!season || !overview) {
      return res.status(400).json({ ok: false, error: '缺少 season 或 overview 字段' });
    }

    const playerInfo = overview.data?.player_info || overview;
    console.log(`[sync-api] Received overview for season=${season}, player=${playerInfo.latest_nickname || 'unknown'}`);

    // 防御：从 hero_stats 重新计算 hero_top
    if (overview.data && overview.data.hero_stats) {
      overview.hero_top = overview.data.hero_stats.map((h) => ({
        hero_name: h.hero_name, battles: h.battles, win_rate: h.win_rate,
      }));
    }

    // 1. Upsert season_summaries
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

    // 2. 写入每日赛季快照
    const today = new Date().toISOString().split('T')[0];
    const metrics = extractMetrics(overview, season);
    const overviewHash = md5(JSON.stringify(metrics));
    const snapshotDoc = {
      date: today, season_id: season, overview_hash: overviewHash,
      metrics, created_at: new Date().toISOString(),
    };
    const snapCol = await collection('season_snapshots');
    const snapExisting = await snapCol.where({ date: today, season_id: season }).get();
    if (snapExisting.data.length > 0) {
      await snapCol.doc(snapExisting.data[0]._id).update(snapshotDoc);
    } else {
      await snapCol.add(snapshotDoc);
    }

    // 3. 清理 90 天前的旧快照
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const oldSnaps = await snapCol.where({ date: { $lte: cutoffDate } }).get();
    for (const s of oldSnaps.data) {
      await snapCol.doc(s._id).remove();
    }
    if (oldSnaps.data.length > 0) {
      console.log(`[sync-api] Cleaned ${oldSnaps.data.length} old snapshots before ${cutoffDate}`);
    }

    // 4. 记录同步快照
    const syncCol = await collection('sync_snapshots');
    await syncCol.add({
      season, type: 'daily', status: 'success',
      source: 'push-api:overview',
      updated_at: new Date().toISOString(),
    });

    console.log(`[sync-api] Overview sync complete: season=${season}`);
    res.json({ ok: true, season, synced: ['season_summaries', 'season_snapshots', 'sync_snapshots'] });
  } catch (err) {
    console.error('[sync-api] Overview sync error:', err.message, err.stack);
    try {
      const syncCol = await collection('sync_snapshots');
      await syncCol.add({
        season: req.body?.season || 'unknown', type: 'daily', status: 'error',
        error: err.message, updated_at: new Date().toISOString(),
      });
    } catch (_) {}
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/sync/schedule — 接收赛程数据并写入 MongoDB
router.post('/sync/schedule', requireSyncKey, async (req, res) => {
  try {
    const { season, schedule } = req.body;
    if (!season || !schedule) {
      return res.status(400).json({ ok: false, error: '缺少 season 或 schedule 字段' });
    }

    const matches = schedule.matches || [];
    console.log(`[sync-api] Received schedule for season=${season}, matches=${matches.length}`);

    if (matches.length === 0) {
      // 记录跳过状态
      const syncCol = await collection('sync_snapshots');
      await syncCol.add({
        season, type: 'schedule', status: 'skipped',
        error: 'schedule has no matches', source: 'push-api:schedule',
        updated_at: new Date().toISOString(),
      });
      return res.json({ ok: true, season, status: 'skipped', message: 'No matches in schedule' });
    }

    const { mergeScheduleMatches, recordSyncSnapshot } = require('../lib/schedule-merge');

    const seasonName = schedule.season_name || season;
    for (const m of matches) { if (!m.season_name) m.season_name = seasonName; }

    const sourceFetchedAt = schedule.updated_at || new Date().toISOString();
    const mergeResult = await mergeScheduleMatches(season, matches, {
      isFullSync: true, isLive: false, sourceFetchedAt,
      sourceStatus: schedule.source_status || 'ok', maxRetries: 3,
    });

    const status = mergeResult.action === 'skipped' ? 'skipped'
      : mergeResult.action === 'no_change' ? 'no_change' : 'success';

    await recordSyncSnapshot({
      type: 'schedule', season, status,
      matchedCount: mergeResult.matchedCount, changedCount: mergeResult.changedCount,
      sourceFetchedAt, error: mergeResult.fallbackUsed ? 'fallback merge key used' : null,
    });

    console.log(`[sync-api] Schedule sync complete: season=${season}, status=${status}, changed=${mergeResult.changedCount}`);
    res.json({
      ok: true, season, status,
      matched_count: mergeResult.matchedCount, changed_count: mergeResult.changedCount,
    });
  } catch (err) {
    console.error('[sync-api] Schedule sync error:', err.message, err.stack);
    try {
      const syncCol = await collection('sync_snapshots');
      await syncCol.add({
        season: req.body?.season || 'unknown', type: 'schedule', status: 'error',
        error: err.message, source: 'push-api:schedule', updated_at: new Date().toISOString(),
      });
    } catch (_) {}
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/sync/status — 查询采集状态和单人数据概览 [需登录]
router.get('/sync/status', requireAuth, async (req, res) => {
  try {
    const syncCol = await collection('sync_snapshots');
    const summaryCol = await collection('season_summaries');

    const [dailySnap, scheduleSnap, summaryDocs] = await Promise.all([
      syncCol.where({ type: 'daily' }).orderBy('updated_at', 'desc').limit(1).get(),
      syncCol.where({ type: 'schedule' }).orderBy('updated_at', 'desc').limit(1).get(),
      summaryCol.orderBy('updated_at', 'desc').limit(1).get(),
    ]);

    const daily = dailySnap.data[0] || null;
    const schedule = scheduleSnap.data[0] || null;
    const summary = summaryDocs.data[0] || null;

    let playerOverview = null;
    if (summary) {
      const overview = summary.data || {};
      const innerData = overview.data || overview;
      const playerInfo = innerData.player_info || {};
      const careerSummary = innerData.career_summary || {};
      const seasonStats = Array.isArray(innerData.season_stats) ? innerData.season_stats : [];
      const currentSeason = seasonStats.find((s) => s.season_id === summary.season) || innerData.current_season || {};
      playerOverview = {
        season: summary.season,
        season_name: summary.season_name,
        player_name: summary.player_name,
        team_name: summary.team_name,
        latest_match_time: playerInfo.latest_match_time || null,
        total_games: playerInfo.total_games ?? careerSummary.total_matches ?? null,
        current_season: {
          battles: currentSeason.battles ?? 0,
          wins: currentSeason.wins ?? 0,
          loses: currentSeason.loses ?? 0,
          win_rate: currentSeason.win_rate ?? null,
          mvp: currentSeason.mvp ?? 0,
          kda_ratio: currentSeason.kda_ratio ?? null,
        },
        updated_at: summary.updated_at,
      };
    }

    res.json({
      ok: true,
      last_daily_sync: daily ? {
        status: daily.status,
        season: daily.season,
        source: daily.source,
        updated_at: daily.updated_at,
        error: daily.error || null,
      } : null,
      last_schedule_sync: schedule ? {
        status: schedule.status,
        season: schedule.season,
        updated_at: schedule.updated_at,
        error: schedule.error || null,
      } : null,
      player_overview: playerOverview,
      schedules: getScheduleList(true),
    });
  } catch (err) {
    console.error('[admin] sync status error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/sync/crawl — 手动触发 KPL 数据采集 [需登录]
router.post('/sync/crawl', requireAuth, async (req, res) => {
  if (!syncKplCrawl) {
    return res.status(500).json({ ok: false, error: 'syncKplCrawl module not loaded' });
  }

  if (!config.crawlEnabled) {
    return res.status(403).json({ ok: false, error: '采集已暂停（CRAWL_ENABLED=false），第三方接口不可用' });
  }

  console.log('[admin] Manual crawl triggered');

  // 异步执行，立即返回确认
  res.json({ ok: true, message: '数据采集已触发，请查看容器日志' });

  try {
    const crawlResult = await syncKplCrawl();
    console.log('[admin] Manual crawl completed:', JSON.stringify(crawlResult));

    // 采集完成后，有数据变更才自动入库
    if (crawlResult.hasChanges) {
      console.log('[admin] Data changed, triggering syncData + syncSchedule');
      if (syncData) {
        console.log('[admin] Triggering syncData...');
        try {
          const dataResult = await syncData();
          console.log('[admin] syncData completed:', JSON.stringify(dataResult));
        } catch (e) {
          console.error('[admin] syncData failed:', e.message);
        }
      }
      if (syncSchedule) {
        console.log('[admin] Triggering syncSchedule...');
        try {
          const scheduleResult = await syncSchedule();
          console.log('[admin] syncSchedule completed:', JSON.stringify(scheduleResult));
        } catch (e) {
          console.error('[admin] syncSchedule failed:', e.message);
        }
      }
      console.log('[admin] Manual crawl + sync all done');
    } else {
      console.log('[admin] No data changes, skipping syncData + syncSchedule');
    }
  } catch (e) {
    console.error('[admin] Manual crawl failed:', e.message);
  }
});

// ── 管理页面（无需鉴权，页面内自带登录逻辑）──
// 前端已拆分为 public/admin.html + admin.css + admin.js，由 /admin-static 提供静态资源
const path = require('path');
const ADMIN_HTML = path.join(__dirname, '..', '..', 'public', 'admin.html');
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(ADMIN_HTML);
});

// ── 查看 AI 配置（需登录）──
router.get('/ai/config', requireAuth, (req, res) => {
  const cfg = getEffectiveConfig();
  res.json({
    base_url: cfg.baseUrl,
    model: cfg.model,
    api_key_configured: !!cfg.apiKey,
    api_key_preview: cfg.apiKey
      ? cfg.apiKey.slice(0, 8) + '...' + cfg.apiKey.slice(-4)
      : '(未设置)',
    source: cfg._source,
  });
});

// ── 更新 AI 配置（需登录）──
router.put('/ai/config', requireAuth, (req, res) => {
  const { baseUrl, apiKey, model } = req.body;
  if (!baseUrl && !apiKey && !model) {
    return res.status(400).json({ ok: false, error: '至少提供一个字段: baseUrl, apiKey, model' });
  }

  const current = getEffectiveConfig();
  try {
    saveConfig({
      baseUrl: baseUrl || current.baseUrl,
      apiKey:  apiKey  || current.apiKey,
      model:   model   || current.model,
    });
    res.json({ ok: true, message: '配置已保存，立即生效' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 测试 AI 连通性（需登录）──
router.post('/ai/test', requireAuth, async (req, res) => {
  const { baseUrl, apiKey, model } = req.body;
  const cfg = getEffectiveConfig();

  const aiBaseUrl = (baseUrl || cfg.baseUrl).replace(/\/+$/, '');
  const aiApiKey = apiKey || cfg.apiKey;
  const aiModel = model || cfg.model;

  if (!aiApiKey) {
    return res.json({ ok: false, error: 'API Key 未配置' });
  }

  try {
    const t0 = Date.now();
    const response = await fetch(`${aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiApiKey}`,
      },
      body: JSON.stringify({
        model: aiModel,
        messages: [{ role: 'user', content: '你好，请回复"OK"' }],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const latency = Date.now() - t0;

    if (!response.ok) {
      const errBody = await response.text();
      let errMsg = errBody;
      try { errMsg = JSON.parse(errBody).error?.message || JSON.parse(errBody).message || errBody; } catch {}
      return res.json({ ok: false, model: aiModel, latency_ms: latency, status: response.status, error: errMsg });
    }

    const data = await response.json();
    res.json({
      ok: true,
      model: aiModel,
      base_url: aiBaseUrl,
      latency_ms: latency,
      reply: data.choices?.[0]?.message?.content?.trim() || '',
      usage: data.usage || null,
    });
  } catch (err) {
    res.json({ ok: false, model: aiModel, error: err.message });
  }
});

module.exports = router;
