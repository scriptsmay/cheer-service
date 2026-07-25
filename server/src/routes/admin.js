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

// ── 鉴权守卫：硬拦截 ──
function requireAuth(req, res, next) {
  if (req.identity && req.identity.ok) return next();
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

    // 采集完成后自动入库，让 sync/status 实时反映
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
  } catch (e) {
    console.error('[admin] Manual crawl failed:', e.message);
  }
});

// ── 管理页面（无需鉴权，页面内自带登录逻辑）──
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(MANAGE_PAGE_HTML);
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

// ═══════════════════════════════════════════════
// 管理页面 HTML（内联，含登录表单）
// ═══════════════════════════════════════════════
const MANAGE_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 配置管理 — Wuyan Cheer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f7fa; color: #1a1a2e; min-height: 100vh; }
  .container { max-width: 680px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .card h2 { font-size: 16px; margin-bottom: 16px; color: #333; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 13px; color: #666; margin-bottom: 4px; font-weight: 500; }
  .form-group input { width: 100%; padding: 10px 12px; border: 1px solid #dde; border-radius: 8px; font-size: 14px; font-family: monospace; background: #fafbfc; transition: border-color .2s; }
  .form-group input:focus { outline: none; border-color: #6366f1; background: #fff; }
  .btn-row { display: flex; gap: 10px; margin-top: 18px; }
  .btn { padding: 10px 24px; border-radius: 8px; border: none; font-size: 14px; font-weight: 500; cursor: pointer; transition: all .2s; }
  .btn-primary { background: #6366f1; color: #fff; }
  .btn-primary:hover { background: #5558e6; }
  .btn-outline { background: #fff; color: #6366f1; border: 1px solid #6366f1; }
  .btn-outline:hover { background: #6366f110; }
  .btn-danger { background: #fff; color: #dc2626; border: 1px solid #fca5a5; font-size: 12px; padding: 6px 14px; }
  .btn-danger:hover { background: #fef2f2; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .result { margin-top: 14px; padding: 12px; border-radius: 8px; font-size: 13px; line-height: 1.6; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
  .result.success { background: #ecfdf5; border: 1px solid #86efac; color: #166534; }
  .result.error { background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; }
  .result.info { background: #eff6ff; border: 1px solid #93c5fd; color: #1e40af; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-env { background: #fef3c7; color: #92400e; }
  .badge-file { background: #dbeafe; color: #1e40af; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin .6s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #loginPanel { display: none; }
  #adminPanel { display: none; }
  #loginPanel.show { display: block; }
  #adminPanel.show { display: block; }
  .logout-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; font-size: 13px; color: #666; }
</style>
</head>
<body>
<div class="container">

  <!-- ═══ 登录面板 ═══ -->
  <div id="loginPanel">
    <h1>🔐 登录管理后台</h1>
    <p class="sub">使用 APP_USERS 中的账号登录</p>
    <div class="card">
      <div class="form-group">
        <label>用户名</label>
        <input id="loginUser" type="text" placeholder="请输入用户名" autocomplete="username">
      </div>
      <div class="form-group">
        <label>密码</label>
        <input id="loginPass" type="password" placeholder="请输入密码" autocomplete="current-password">
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="doLogin()">登录</button>
      </div>
      <div id="loginMsg"></div>
    </div>
  </div>

  <!-- ═══ 管理面板 ═══ -->
  <div id="adminPanel">
    <div class="logout-bar">
      <span>👤 已登录</span>
      <button class="btn btn-danger" onclick="doLogout()">退出登录</button>
    </div>
    <h1>⚙️ Wuyan Cheer — AI 配置管理</h1>
    <p class="sub">修改后即时生效，无需重启容器</p>

    <!-- 当前状态 -->
    <div class="card">
      <h2>📋 当前配置 <span id="sourceBadge" class="badge badge-env"></span></h2>
      <div style="font-size:13px;color:#666">
        <div>Endpoint: <strong id="curUrl">-</strong></div>
        <div>Model: <strong id="curModel">-</strong></div>
        <div>API Key: <strong id="curKey">-</strong></div>
      </div>
    </div>

    <!-- 修改配置 -->
    <div class="card">
      <h2>✏️ 修改配置</h2>
      <div class="form-group">
        <label>API Base URL</label>
        <input id="inpUrl" placeholder="https://api.deepseek.com/v1">
      </div>
      <div class="form-group">
        <label>API Key</label>
        <input id="inpKey" type="password" placeholder="sk-xxxxxxxx">
      </div>
      <div class="form-group">
        <label>Model</label>
        <input id="inpModel" placeholder="deepseek-chat">
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="saveConfig()">💾 保存配置</button>
        <button class="btn btn-outline" onclick="testAI()">🔍 测试连接</button>
      </div>
      <div id="cfgResult"></div>
    </div>

    <!-- 测试结果 -->
    <div id="testResult"></div>

    <!-- 数据采集 -->
    <div class="card">
      <h2>📡 KPL 数据采集</h2>
      <p style="font-size:13px;color:#666;margin-bottom:12px">手动触发 Python 爬虫采集 KPL 数据（main.py + fetch-schedule.py），异步执行，结果见容器日志。</p>
      <div id="syncStatus" style="margin-bottom:16px">
        <div style="font-size:13px;color:#666;margin-bottom:8px">⏳ 加载中...</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-outline" id="crawlBtn" onclick="triggerCrawl()">🔄 手动采集</button>
        <button class="btn btn-outline" id="refreshBtn" onclick="refreshSyncStatus()">↻ 刷新状态</button>
      </div>
      <div id="crawlResult"></div>
    </div>
  </div>

</div>

<script>
const TOKEN_KEY = 'wuyan_admin_token';
const API = '/api/admin/ai';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

function authHeaders() {
  const t = getToken();
  return t ? { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

function showLogin() {
  document.getElementById('loginPanel').classList.add('show');
  document.getElementById('adminPanel').classList.remove('show');
  document.getElementById('loginUser').focus();
}

function showAdmin() {
  document.getElementById('loginPanel').classList.remove('show');
  document.getElementById('adminPanel').classList.add('show');
  refresh();
  refreshSyncStatus();
}

// ── 登录 ──
async function doLogin() {
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value.trim();
  const el = document.getElementById('loginMsg');
  if (!user || !pass) { el.innerHTML = '<div class="result error">请输入用户名和密码</div>'; return; }
  el.innerHTML = '<div class="result info"><span class="spinner"></span>登录中...</div>';

  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username:user,password:pass}) });
    const d = await r.json();
    if (!r.ok || !d.data || !d.data.access_token) {
      el.innerHTML = '<div class="result error">❌ ' + (d.message || '登录失败') + '</div>';
      return;
    }
    setToken(d.data.access_token);
    el.innerHTML = '';
    showAdmin();
  } catch(e) {
    el.innerHTML = '<div class="result error">❌ 网络错误: ' + e.message + '</div>';
  }
}

// 回车登录
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && document.getElementById('loginPanel').classList.contains('show')) {
    doLogin();
  }
});

// ── 登出 ──
function doLogout() {
  clearToken();
  showLogin();
}

// ── API 封装（自动处理 401）──
async function api(method, path, body) {
  const headers = authHeaders();
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) { clearToken(); showLogin(); return null; }
  return r;
}

// ── 刷新当前配置 ──
async function refresh() {
  const r = await api('GET', API + '/config');
  if (!r) return;
  const d = await r.json();
  document.getElementById('curUrl').textContent = d.base_url;
  document.getElementById('curModel').textContent = d.model;
  document.getElementById('curKey').textContent = d.api_key_preview;
  const badge = document.getElementById('sourceBadge');
  badge.textContent = d.source === 'file' ? '已自定义' : '环境变量默认';
  badge.className = 'badge ' + (d.source === 'file' ? 'badge-file' : 'badge-env');
  document.getElementById('inpUrl').placeholder = d.base_url;
  document.getElementById('inpModel').placeholder = d.model;
}

// ── 保存配置 ──
async function saveConfig() {
  const body = {};
  const url = document.getElementById('inpUrl').value.trim();
  const key = document.getElementById('inpKey').value.trim();
  const model = document.getElementById('inpModel').value.trim();
  if (url) body.baseUrl = url;
  if (key) body.apiKey = key;
  if (model) body.model = model;

  const el = document.getElementById('cfgResult');
  if (!Object.keys(body).length) { el.innerHTML = '<div class="result error">请至少填写一项</div>'; return; }

  const r = await api('PUT', API + '/config', body);
  if (!r) return;
  const d = await r.json();
  el.innerHTML = d.ok
    ? '<div class="result success">✅ ' + d.message + '</div>'
    : '<div class="result error">❌ ' + (d.error || '保存失败') + '</div>';
  refresh();
}

// ── 测试连接 ──
async function testAI() {
  const el = document.getElementById('testResult');
  el.innerHTML = '<div class="result info"><span class="spinner"></span>测试中，请稍候...</div>';

  const body = {};
  const url = document.getElementById('inpUrl').value.trim();
  const key = document.getElementById('inpKey').value.trim();
  const model = document.getElementById('inpModel').value.trim();
  if (url) body.baseUrl = url;
  if (key) body.apiKey = key;
  if (model) body.model = model;

  const r = await api('POST', API + '/test', body);
  if (!r) return;
  const d = await r.json();
  if (d.ok) {
    el.innerHTML = '<div class="result success">✅ 连接成功 | 延迟: <b>' + d.latency_ms + 'ms</b> | 模型: <b>' + d.model + '</b> | 回复: <b>' + d.reply + '</b> | Tokens: ' + JSON.stringify(d.usage) + '</div>';
  } else {
    el.innerHTML = '<div class="result error">❌ 连接失败 | 延迟: <b>' + d.latency_ms + 'ms</b>' + (d.status ? ' | HTTP ' + d.status : '') + '<br>' + (d.error || '未知错误') + '</div>';
  }
}

// ── 格式化时间 ──
function formatTime(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  } catch { return isoStr; }
}

// ── 状态徽章样式 ──
function statusBadge(status) {
  const map = {
    success:   { bg: '#dcfce7', fg: '#166534', label: '成功' },
    no_change: { bg: '#e0e7ff', fg: '#3730a3', label: '无变化' },
    skipped:   { bg: '#fef3c7', fg: '#92400e', label: '跳过' },
    error:     { bg: '#fecaca', fg: '#991b1b', label: '失败' },
  };
  const s = map[status] || { bg: '#e5e7eb', fg: '#374151', label: status || '未知' };
  return '<span class="badge" style="background:' + s.bg + ';color:' + s.fg + '">' + s.label + '</span>';
}

// ── 刷新采集状态 ──
async function refreshSyncStatus() {
  const el = document.getElementById('syncStatus');
  el.innerHTML = '<div style="font-size:13px;color:#666">⏳ 加载中...</div>';
  try {
    const r = await api('GET', '/api/admin/sync/status');
    if (!r) return;
    const d = await r.json();
    if (!d.ok) {
      el.innerHTML = '<div class="result error" style="margin:0">❌ ' + (d.error || '加载失败') + '</div>';
      return;
    }

    let html = '';

    if (d.last_daily_sync) {
      html += '<div style="font-size:13px;margin-bottom:8px"><b>📊 单人数据:</b> '
        + statusBadge(d.last_daily_sync.status)
        + ' <span style="color:#666">赛季: ' + (d.last_daily_sync.season || '-') + '</span><br>'
        + '<span style="color:#888;font-size:12px">上次更新: ' + formatTime(d.last_daily_sync.updated_at) + '</span>'
        + (d.last_daily_sync.error ? '<br><span style="color:#dc2626;font-size:12px">错误: ' + d.last_daily_sync.error + '</span>' : '')
        + '</div>';
    } else {
      html += '<div style="font-size:13px;margin-bottom:8px"><b>📊 单人数据:</b> <span style="color:#888">暂无记录</span></div>';
    }

    if (d.last_schedule_sync) {
      html += '<div style="font-size:13px;margin-bottom:8px"><b>📅 赛程数据:</b> '
        + statusBadge(d.last_schedule_sync.status)
        + ' <span style="color:#666">赛季: ' + (d.last_schedule_sync.season || '-') + '</span><br>'
        + '<span style="color:#888;font-size:12px">上次更新: ' + formatTime(d.last_schedule_sync.updated_at) + '</span>'
        + (d.last_schedule_sync.error ? '<br><span style="color:#dc2626;font-size:12px">错误: ' + d.last_schedule_sync.error + '</span>' : '')
        + '</div>';
    } else {
      html += '<div style="font-size:13px;margin-bottom:8px"><b>📅 赛程数据:</b> <span style="color:#888">暂无记录</span></div>';
    }

    if (d.player_overview) {
      const p = d.player_overview;
      const cs = p.current_season || {};
      html += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee">'
        + '<div style="font-size:13px;font-weight:600;margin-bottom:6px">👤 ' + (p.player_name || '-')
        + ' <span style="color:#888;font-weight:normal">' + (p.team_name || '') + '</span></div>'
        + '<div style="font-size:12px;color:#666;line-height:1.8">'
        + '赛季: ' + (p.season_name || p.season || '-') + '<br>'
        + '最后比赛: ' + (p.latest_match_time || '-') + '<br>'
        + '当前赛季: ' + (cs.battles || 0) + ' 场 / ' + (cs.wins || 0) + '胜' + (cs.loses || 0) + '负'
        + (cs.win_rate ? ' (' + cs.win_rate + ')' : '')
        + (cs.mvp ? ' / MVP: ' + cs.mvp : '')
        + (cs.kda_ratio ? ' / KDA: ' + cs.kda_ratio : '')
        + '<br>'
        + '<span style="color:#888">数据入库时间: ' + formatTime(p.updated_at) + '</span>'
        + '</div></div>';
    }

    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div class="result error" style="margin:0">❌ 网络错误: ' + e.message + '</div>';
  }
}

// ── 手动采集 ──
async function triggerCrawl() {
  const el = document.getElementById('crawlResult');
  const btn = document.getElementById('crawlBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>采集中...';
  el.innerHTML = '<div class="result info">⏳ 采集任务已提交，异步执行中，请查看容器日志...</div>';

  try {
    const r = await api('POST', '/api/admin/sync/crawl');
    if (!r) { btn.disabled = false; btn.innerHTML = '🔄 手动采集'; return; }
    const d = await r.json();
    if (d.ok) {
      el.innerHTML = '<div class="result success">✅ ' + d.message + '</div>';
    } else {
      el.innerHTML = '<div class="result error">❌ ' + (d.error || '触发失败') + '</div>';
    }
  } catch(e) {
    el.innerHTML = '<div class="result error">❌ 网络错误: ' + e.message + '</div>';
  }
  btn.disabled = false;
  btn.innerHTML = '🔄 手动采集';
}
(async function init() {
  const t = getToken();
  if (!t) { showLogin(); return; }
  // 用已有 token 尝试拉配置，失败就跳登录
  const r = await fetch(API + '/config', { headers: authHeaders() });
  if (r.status === 401) { clearToken(); showLogin(); return; }
  setToken(t);
  showAdmin();
})();
</script>
</body>
</html>`;

module.exports = router;
