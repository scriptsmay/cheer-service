'use strict';

/**
 * /api/admin — 运维管理（需登录）
 *
 * GET  /api/admin              — 管理页面 (HTML，含登录表单)
 * GET  /api/admin/ai/config    — 查看当前 AI 配置（脱敏）[需登录]
 * PUT  /api/admin/ai/config    — 更新 AI 配置（持久化到 /app/data/ai-config.json）[需登录]
 * POST /api/admin/ai/test      — 测试 AI 连通性 [需登录]
 */

const express = require('express');
const router = express.Router();
const { getEffectiveConfig, saveConfig } = require('../services/ai-config');

// ── 鉴权守卫：硬拦截 ──
function requireAuth(req, res, next) {
  if (req.identity && req.identity.ok) return next();
  return res.status(401).json({ code: 'UNAUTHORIZED', message: '请先登录' });
}

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

// ── 初始化：检查已有 token ──
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
