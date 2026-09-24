'use strict';

/**
 * /api/admin — 运维管理（需登录）
 *
 * GET  /api/admin              — 管理页面 (HTML，含登录表单)
 * GET  /api/admin/ai/config    — 查看当前 AI 配置（脱敏）[需登录]
 * PUT  /api/admin/ai/config    — 更新 AI 配置（持久化到 /app/data/ai-config.json）[需登录]
 * POST /api/admin/ai/models    — 拉取可用模型列表（OpenAI /models 约定）[需登录]
 * POST /api/admin/ai/test      — 测试 AI 连通性 [需登录]
 *
 * KPL 数据链路：采集在宿主机 systemd timer（kpl-data-daily 仓），容器只读挂载；
 * 同步状态见 GET /api/admin/sync/status，手动同步见 POST /api/admin/sync/crawl。
 * 调度配置已废弃（Phase 3），定时任务走 Vercel Cron /api/cron/daily。
 */

const express = require('express');
const router = express.Router();
const { getEffectiveConfig, saveConfig } = require('../services/ai-config');
const { fetchAvailableModels } = require('../services/ai-models');
const {
  getCheerSettings,
  setCheerSettings,
  setCheerDataMode,
  CHEER_DATA_MODES,
  getCheerPrompts,
  setCheerPrompts,
  resetCheerPrompts,

  getCheerEvents,
  setCheerEvent,
  deleteCheerEvent,
} = require('../services/settings-store');
const { collection, command } = require('../db');
const config = require('../config/env');

// kpl-data-daily 手动同步（读取采集产物入库），编排逻辑在 syncKplCrawl 内
let syncKplCrawl;
let isSyncRunning = () => false;
try {
  ({ syncKplCrawl, isSyncRunning } = require('../jobs/syncKplCrawl'));
} catch (e) {
  console.error('[admin] syncKplCrawl 模块加载失败:', e.message);
}
// 调度配置已移除（Phase 3），定时任务走 Vercel Cron

// ── 鉴权守卫：硬拦截（仅允许 JWT 登录用户，拒绝匿名/旧版 Token）──
function requireAuth(req, res, next) {
  if (req.identity && req.identity.ok && req.identity.kind === 'session') return next();
  return res.status(401).json({ code: 'UNAUTHORIZED', message: '请先登录' });
}

const AI_STATS_WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

router.get('/ai/stats', requireAuth, async (req, res) => {
  const window = req.query.window || '24h';
  const duration = AI_STATS_WINDOWS[window];
  if (!duration) {
    return res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'window 必须是 24h、7d 或 30d' });
  }

  try {
    const attemptsCol = await collection('ai_generation_attempts');
    const cutoff = new Date(Date.now() - duration).toISOString();
    const result = await attemptsCol.where({ created_at: command.gte(cutoff) }).get();
    const grouped = new Map();

    for (const attempt of result.data || []) {
      const model = attempt.model || 'unknown';
      if (!grouped.has(model)) grouped.set(model, []);
      grouped.get(model).push(attempt);
    }

    const models = [...grouped.entries()].map(([model, attempts]) => {
      const complete = attempts.filter((attempt) => attempt.status === 'complete').length;
      const elapsed = attempts.map((attempt) => attempt.elapsed_ms).filter(Number.isFinite);
      return {
        model,
        samples: attempts.length,
        complete,
        success_rate: attempts.length ? complete / attempts.length : 0,
        p50_ms: percentile(elapsed, 0.5),
        p95_ms: percentile(elapsed, 0.95),
        retries: attempts.reduce((sum, attempt) => sum + (Number(attempt.retry_count) || 0), 0),
        validation_failures: attempts.filter((attempt) => attempt.validation_failure).length,
        validation_reasons: attempts.reduce((counts, attempt) => {
          const reason = attempt.validation_failure;
          if (reason) counts[reason] = (counts[reason] || 0) + 1;
          return counts;
        }, {}),
        tokens: attempts.reduce((sum, attempt) => sum + (Number(attempt.usage?.total_tokens) || 0), 0),
      };
    });

    models.sort((a, b) => b.success_rate - a.success_rate || (a.p95_ms || Infinity) - (b.p95_ms || Infinity));
    res.json({ window, generated_at: new Date().toISOString(), models });
  } catch (err) {
    res.status(500).json({ code: 500, message: '服务内部错误' });
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

// POST /api/admin/sync/crawl — 手动触发 KPL 数据同步（变更检测+入库编排见 syncKplCrawl）[需登录]
router.post('/sync/crawl', requireAuth, async (req, res) => {
  if (!syncKplCrawl) {
    return res.status(500).json({ ok: false, error: 'syncKplCrawl module not loaded' });
  }

  if (!config.crawlEnabled) {
    return res.status(403).json({ ok: false, error: '数据同步已暂停（CRAWL_ENABLED=false）' });
  }

  if (isSyncRunning()) {
    return res.status(409).json({ ok: false, error: '同步任务正在进行中，请等待完成后刷新状态' });
  }

  console.log('[admin] Manual kpl sync triggered');

  // 先应答再执行：全量同步可达数分钟，超过 serverless 单次调用时长上限，
  // 同步结果与失败原因以日志和 GET /api/admin/sync/status 的快照为准。
  res.json({ ok: true, message: '数据同步已在后台执行，稍后刷新本页查看同步状态' });

  try {
    const result = await syncKplCrawl();
    console.log('[admin] Manual kpl sync completed:', JSON.stringify(result));
  } catch (e) {
    console.error('[admin] Manual kpl sync failed:', e.message);
  }
});

// ── 管理页面（无需鉴权，页面内自带登录逻辑）──
// 前端为自包含 public/admin.html（v1.1.0 起按原型蓝本单文件落地，DEMO 已移除）
const path = require('path');
const ADMIN_HTML = path.join(__dirname, '..', '..', 'public', 'admin.html');
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(ADMIN_HTML);
});

// ── 查看 AI 配置（需登录）──
router.get('/ai/config', requireAuth, async (req, res) => {
  const cfg = await getEffectiveConfig();
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
router.put('/ai/config', requireAuth, async (req, res) => {
  const { baseUrl, apiKey, model } = req.body;
  if (!baseUrl && !apiKey && !model) {
    return res.status(400).json({ ok: false, error: '至少提供一个字段: baseUrl, apiKey, model' });
  }

  const current = await getEffectiveConfig();
  try {
    await saveConfig({
      baseUrl: baseUrl || current.baseUrl,
      apiKey:  apiKey  || current.apiKey,
      model:   model   || current.model,
    });
    res.json({ ok: true, message: '配置已保存，立即生效' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 拉取可用模型列表（需登录）──
// 入参 {baseUrl?, apiKey?} 缺省时回退到当前生效配置（支持只配了 endpoint、未重填 key 的场景）
router.post('/ai/models', requireAuth, async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  try {
    const result = await fetchAvailableModels({ baseUrl, apiKey });
    if (result.ok) return res.json(result);
    return res.status(502).json({ ok: false, error: result.error, endpoint: result.endpoint });
  } catch (e) {
    if (['NO_KEY', 'NO_BASE_URL', 'INVALID_URL', 'SSRF_BLOCKED', 'KEY_REQUIRED_FOR_NEW_ENDPOINT'].includes(e.code)) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    return res.status(502).json({ ok: false, error: e.message });
  }
});

// ── 测试 AI 连通性（需登录）──
router.post('/ai/test', requireAuth, async (req, res) => {
  const { baseUrl, apiKey, model } = req.body;
  const cfg = await getEffectiveConfig();

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
// 应援文案数据模式 / 事件 / 提示词配置（需登录，改完立即生效）
// ═══════════════════════════════════════════════

const CHEER_MODE_LABELS = {
  season: '当前赛季数据',
  career: '生涯数据（缺赛期）',
  emotion: '纯情绪（不注入数据）',
};

// GET /api/admin/cheer/config — 查看应援文案数据模式 + 功能开关
router.get('/cheer/config', requireAuth, async (req, res) => {
  try {
    const settings = await getCheerSettings();
    res.json({
      ok: true,
      data_mode: settings.mode,
      data_mode_label: CHEER_MODE_LABELS[settings.mode] || settings.mode,
      date_context_enabled: settings.date_context_enabled,
      humanize_enabled: settings.humanize_enabled,
      event_context_enabled: settings.event_context_enabled,
      source: settings.source,
      options: CHEER_DATA_MODES.map((m) => ({ value: m, label: CHEER_MODE_LABELS[m] })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/admin/cheer/config — 更新应援文案数据模式 / 功能开关
router.put('/cheer/config', requireAuth, async (req, res) => {
  const body = req.body || {};
  const mode = typeof body.data_mode === 'string' ? body.data_mode.toLowerCase() : '';
  const patch = {};

  if (mode) {
    if (!CHEER_DATA_MODES.includes(mode)) {
      return res.status(400).json({ ok: false, error: `data_mode 必须是 ${CHEER_DATA_MODES.join(' / ')}` });
    }
    patch.data_mode = mode;
  }
  for (const key of ['date_context_enabled', 'humanize_enabled', 'event_context_enabled']) {
    if (typeof body[key] === 'boolean') patch[key] = body[key];
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, error: '至少提供一个字段: data_mode 或三个开关之一' });
  }

  try {
    let saved;
    if (patch.data_mode) {
      await setCheerDataMode(patch.data_mode);
      delete patch.data_mode;
    }
    if (Object.keys(patch).length) {
      saved = await setCheerSettings(patch);
    } else {
      const settings = await getCheerSettings();
      saved = settings;
    }
    res.json({
      ok: true,
      data_mode: saved.mode,
      data_mode_label: CHEER_MODE_LABELS[saved.mode] || saved.mode,
      date_context_enabled: saved.date_context_enabled,
      humanize_enabled: saved.humanize_enabled,
      event_context_enabled: saved.event_context_enabled,
      message: '已保存，下一次文案生成立即生效',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 应援事件管理（cheer_events 事件表 CRUD，需登录）──

// GET /api/admin/cheer/events — 事件列表
router.get('/cheer/events', requireAuth, async (req, res) => {
  try {
    const events = await getCheerEvents();
    res.json({ ok: true, events });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/admin/cheer/events — 新增/更新事件（_id 幂等）
router.put('/cheer/events', requireAuth, async (req, res) => {
  try {
    const saved = await setCheerEvent(req.body || {});
    res.json({ ok: true, event: saved, message: '事件已保存，命中窗口内自动生效' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// DELETE /api/admin/cheer/events/:id — 删除事件
router.delete('/cheer/events/:id', requireAuth, async (req, res) => {
  try {
    await deleteCheerEvent(req.params.id);
    res.json({ ok: true, message: '事件已删除' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── 提示词配置化（v1.1.0 Task 3，需登录；30s TTL 缓存，改完自动生效）──

// GET /api/admin/cheer/prompts — 查看生效提示词配置（含代码默认回退后的完整字段 + 版本号）
router.get('/cheer/prompts', requireAuth, async (req, res) => {
  try {
    const prompts = await getCheerPrompts();
    res.json({
      ok: true,
      prompts,
      version: prompts.version,
      customized: prompts.version >= 1,
      placeholders: ['line_count', 'line_min_chars', 'event_min_lines', 'event_text', 'date_label', 'anchors_text', 'recent_openings', 'roles_hint'],
      message: prompts.version >= 1 ? '当前为后台自定义配置' : '当前为代码默认模板（未自定义）',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/admin/cheer/prompts — 保存提示词配置（占位符/数值硬校验，非法拒绝落库；version 自增）
router.put('/cheer/prompts', requireAuth, async (req, res) => {
  try {
    const saved = await setCheerPrompts(req.body || {});
    res.json({ ok: true, prompts: saved, version: saved.version, message: '提示词已保存，下一次文案生成即生效（TTL 缓存 ≤30s）' });
  } catch (err) {
    if (err.code === 'INVALID_PROMPTS') return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/admin/cheer/prompts — 删除 DB 子文档回代码默认模板（version 归 0，即「恢复默认」）
router.delete('/cheer/prompts', requireAuth, async (req, res) => {
  try {
    const defaults = await resetCheerPrompts();
    res.json({ ok: true, prompts: defaults, version: 0, message: '已恢复代码默认模板' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
