/* ============================================================
 * admin.js — 管理后台逻辑（v1.1.0 重设计：4 分区路由 + 总览 + 提示词配置）
 * 依赖 admin-utils.js 的全局工具函数；DOM 就绪后 init() 启动
 * ============================================================ */

'use strict';
/* ════════════════════════════════════════════════
 * 3. 外壳 / 路由
 * ════════════════════════════════════════════════ */
const ROUTES = ['overview', 'ai', 'cheer', 'sync'];
const ROUTE_TITLES = { overview: '总览', ai: 'AI 服务', cheer: '应援文案', sync: '数据采集' };
function currentRoute() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  return (m && ROUTES.includes(m[1])) ? m[1] : 'overview';
}
function renderRoute() {
  const r = currentRoute();
  document.querySelectorAll('.nav-item').forEach((a) => {
    const on = a.dataset.route === r;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  ROUTES.forEach((k) => { document.getElementById('view-' + k).hidden = (k !== r); });
  document.title = ROUTE_TITLES[r] + ' · Wuyan Cheer 管理后台';
  ({ overview: refreshOverview, ai: refresh, cheer: refreshCheerSection, sync: refreshSyncSection }[r])();
}
window.addEventListener('hashchange', renderRoute);

function showLogin() {
  document.getElementById('adminPanel').hidden = true;
  document.getElementById('loginPanel').hidden = false;
  setTimeout(() => { document.getElementById('loginUser').focus(); }, 30);
}
function showAdmin() {
  document.getElementById('loginPanel').hidden = true;
  document.getElementById('adminPanel').hidden = false;
  renderRoute();
}
async function doLogin(e) {
  if (e) e.preventDefault();
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value.trim();
  const el = document.getElementById('loginMsg');
  if (!user || !pass) { el.innerHTML = '<div class="result error">请输入用户名和密码</div>'; return; }
  el.innerHTML = '<div class="result info"><span class="spinner"></span>登录中…</div>';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
    const d = await r.json();
    if (!r.ok || !d.data || !d.data.access_token) {
      el.innerHTML = '<div class="result error">' + escapeHtml(d.message || '登录失败') + '</div>';
      return;
    }
    setToken(d.data.access_token);
    el.innerHTML = '';
    showAdmin();
  } catch (err) {
    el.innerHTML = '<div class="result error">❌ 网络错误: ' + escapeHtml(err.message) + '</div>';
  }
}
function doLogout() { clearToken(); showLogin(); }

/* ════════════════════════════════════════════════
 * 4. 轻提示 / 确认弹窗
 * ════════════════════════════════════════════════ */
const TOAST_ICON = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
};
function toast(msg, type) {
  type = type || 'success';
  const host = document.getElementById('toastHost');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = (TOAST_ICON[type] || TOAST_ICON.info) + '<span>' + msg + '</span>';
  host.appendChild(t);
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 260); }, 3200);
}
function confirmDanger(title, desc) {
  return new Promise((resolve) => {
    const mask = document.getElementById('confirmMask');
    document.getElementById('confirmTitleText').textContent = title;
    document.getElementById('confirmDesc').textContent = desc;
    mask.hidden = false;
    const done = (v) => { mask.hidden = true; cleanup(); resolve(v); };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    const onMask = (e) => { if (e.target === mask) done(false); };
    function cleanup() {
      document.getElementById('confirmOk').removeEventListener('click', onOk);
      document.getElementById('confirmCancel').removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      mask.removeEventListener('click', onMask);
    }
    document.getElementById('confirmOk').addEventListener('click', onOk);
    document.getElementById('confirmCancel').addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    document.addEventListener('keydown', onKey);
    document.getElementById('confirmCancel').focus();
  });
}

/* ════════════════════════════════════════════════
 * 5. AI 服务
 * ════════════════════════════════════════════════ */
async function refresh() {
  try {
    const r = await api('GET', '/api/admin/ai/config');
    if (!r) return;
    const d = await r.json();
    document.getElementById('curUrl').textContent = d.base_url || '-';
    document.getElementById('curModel').textContent = d.model || '-';
    document.getElementById('curKey').textContent = d.api_key_preview || '-';
    const label = d.source === 'file' ? '已自定义' : '环境变量默认';
    const cls = d.source === 'file' ? 'badge badge-file' : 'badge badge-env';
    const badge = document.getElementById('sourceBadge');
    badge.textContent = label; badge.className = cls;
    document.getElementById('inpUrl').placeholder = d.base_url || '';
    document.getElementById('inpModel').placeholder = (d.model || '') + '（可手动填写，或点右侧获取）';
    const ob = document.getElementById('ovAiBadge');
    ob.textContent = label; ob.className = cls; ob.hidden = false;
    document.getElementById('ovAiModel').textContent = d.model || '-';
    document.getElementById('ovAiEndpoint').textContent = d.base_url || '-';
  } catch (e) {
    const ov = document.getElementById('ovAiModel');
    ov.textContent = '加载失败'; document.getElementById('ovAiEndpoint').textContent = '';
  }
}
async function saveConfig() {
  const body = {};
  const url = document.getElementById('inpUrl').value.trim();
  const key = document.getElementById('inpKey').value.trim();
  const model = document.getElementById('inpModel').value.trim();
  if (url) body.baseUrl = url;
  if (key) body.apiKey = key;
  if (model) body.model = model;
  if (!Object.keys(body).length) { toast('请至少填写一项再保存', 'error'); return; }
  const btn = document.getElementById('saveConfigBtn');
  btn.disabled = true;
  const r = await api('PUT', '/api/admin/ai/config', body);
  btn.disabled = false;
  if (!r) return;
  const d = await r.json();
  if (d.ok) {
    document.getElementById('inpUrl').value = '';
    document.getElementById('inpKey').value = '';
    document.getElementById('inpModel').value = '';
    toast(escapeHtml(d.message || '配置已保存'));
    refresh();
  } else {
    toast(escapeHtml(d.error || '保存失败'), 'error');
  }
}
async function testAI() {
  const el = document.getElementById('testResult');
  el.innerHTML = '<div class="result info"><span class="spinner"></span>测试中，请稍候…</div>';
  const body = {};
  const url = document.getElementById('inpUrl').value.trim();
  const key = document.getElementById('inpKey').value.trim();
  const model = document.getElementById('inpModel').value.trim();
  if (url) body.baseUrl = url;
  if (key) body.apiKey = key;
  if (model) body.model = model;
  const r = await api('POST', '/api/admin/ai/test', body);
  if (!r) { el.innerHTML = ''; return; }
  const d = await r.json();
  if (d.ok) {
    el.innerHTML = '<div class="result success test-grid">'
      + '<span>状态</span><b>连接成功</b>'
      + '<span>延迟</span><b>' + escapeHtml(String(d.latency_ms)) + ' ms</b>'
      + '<span>模型</span><b>' + escapeHtml(d.model || '') + '</b>'
      + '<span>回复</span><span>' + escapeHtml(d.reply || '') + '</span>'
      + '<span>Tokens</span><span>' + escapeHtml(JSON.stringify(d.usage)) + '</span>'
      + '</div>';
  } else {
    el.innerHTML = '<div class="result error"><b>连接失败</b>'
      + (d.latency_ms ? '（' + escapeHtml(String(d.latency_ms)) + ' ms）' : '')
      + (d.status ? ' HTTP ' + escapeHtml(String(d.status)) : '')
      + '<br>' + escapeHtml(d.error || '未知错误') + '</div>';
  }
}

let fetchedModelsCache = [];
let isFetchingModels = false;
async function fetchModelList() {
  if (isFetchingModels) return;
  const url = document.getElementById('inpUrl').value.trim();
  const key = document.getElementById('inpKey').value.trim();
  const resEl = document.getElementById('modelFetchResult');
  const btn = document.getElementById('fetchModelsBtn');
  const cacheKey = (url || '(current)') + '\n' + key;
  const cached = fetchedModelsCache.find((x) => x.endpoint === cacheKey);
  if (cached) {
    renderModelPicker(cached.models);
    resEl.textContent = '已使用缓存的 ' + cached.models.length + ' 个模型';
    return;
  }
  isFetchingModels = true;
  const original = btn.textContent;
  btn.textContent = '获取中…';
  btn.disabled = true;
  resEl.textContent = '';
  hideModelPicker();
  try {
    const r = await api('POST', '/api/admin/ai/models', { baseUrl: url || undefined, apiKey: key || undefined });
    if (!r) return;
    const d = await r.json();
    if (d.ok && d.models && d.models.length) {
      fetchedModelsCache = [{ endpoint: cacheKey, models: d.models }]
        .concat(fetchedModelsCache.filter((x) => x.endpoint !== cacheKey));
      renderModelPicker(d.models);
      resEl.textContent = '已获取 ' + d.models.length + ' 个模型，点击选择，也可手动输入';
    } else {
      resEl.textContent = '未获取到模型，请手动填写：' + (d.error || '未知错误');
      hideModelPicker();
    }
  } catch (e) {
    resEl.textContent = '请求失败：' + e.message;
  } finally {
    isFetchingModels = false;
    btn.textContent = original;
    btn.disabled = false;
  }
}
function renderModelPicker(models) {
  const box = document.getElementById('modelPicker');
  box.replaceChildren(...models.map((m) => {
    const item = document.createElement('div');
    item.className = 'model-picker__item';
    item.setAttribute('role', 'option');
    item.textContent = m;
    item.addEventListener('click', () => pickModel(m));
    return item;
  }));
  box.hidden = false;
}
function pickModel(id) {
  document.getElementById('inpModel').value = id;
  hideModelPicker();
}
function hideModelPicker() { document.getElementById('modelPicker').hidden = true; }

let isFetchingCurrentModels = false;
async function fetchModelsForCurrent() {
  if (isFetchingCurrentModels) return;
  const resEl = document.getElementById('curModelFetchResult');
  isFetchingCurrentModels = true;
  resEl.textContent = '获取中…';
  hideCurrentModelPicker();
  try {
    const r = await api('POST', '/api/admin/ai/models', {});
    if (!r) return;
    const d = await r.json();
    if (d.ok && d.models && d.models.length) {
      renderCurrentModelPicker(d.models);
      resEl.textContent = '已获取 ' + d.models.length + ' 个模型，点击直接切换';
    } else {
      resEl.textContent = '当前端点未获取到模型，可在下方表单手动填写：' + (d.error || '');
      hideCurrentModelPicker();
    }
  } catch (e) {
    resEl.textContent = '请求失败：' + e.message;
  } finally {
    isFetchingCurrentModels = false;
  }
}
function renderCurrentModelPicker(models) {
  const box = document.getElementById('curModelPicker');
  box.replaceChildren(...models.map((m) => {
    const item = document.createElement('div');
    item.className = 'model-picker__item';
    item.setAttribute('role', 'option');
    item.textContent = m;
    item.addEventListener('click', () => pickCurrentModel(m));
    return item;
  }));
  box.hidden = false;
}
async function pickCurrentModel(id) {
  const r = await api('PUT', '/api/admin/ai/config', { model: id });
  if (!r) return;
  const d = await r.json();
  if (d.ok) {
    hideCurrentModelPicker();
    document.getElementById('curModelFetchResult').textContent = '已更新为：' + id;
    toast('模型已切换为 ' + escapeHtml(id));
    refresh();
  }
}
function hideCurrentModelPicker() { document.getElementById('curModelPicker').hidden = true; }

/* ════════════════════════════════════════════════
 * 6. 应援文案
 * ════════════════════════════════════════════════ */
let currentCheerMode = 'season';
async function refreshCheerMode() {
  try {
    const r = await api('GET', '/api/admin/cheer/config');
    if (!r) return;
    const d = await r.json();
    if (!d.ok) return;
    currentCheerMode = d.data_mode;
    const badge = document.getElementById('cheerModeSourceBadge');
    badge.textContent = d.source === 'db' ? '已自定义' : '环境变量默认';
    badge.className = 'badge ' + (d.source === 'db' ? 'badge-file' : 'badge-env');
    document.getElementById('dateCtxEnabled').checked = d.date_context_enabled !== false;
    document.getElementById('humanizeEnabled').checked = d.humanize_enabled !== false;
    document.getElementById('eventCtxEnabled').checked = d.event_context_enabled !== false;
    const descs = {
      season: '注入当前赛季战绩（KDA、胜率、对局数、MVP、常用英雄）',
      career: '注入生涯汇总数据，并禁止前瞻性赛程表述（适用于缺赛期）',
      emotion: '不注入任何数据，生成纯情绪应援文案',
    };
    const box = document.getElementById('cheerModeOptions');
    box.innerHTML = (d.options || []).map((opt) => {
      const sel = opt.value === d.data_mode ? ' selected' : '';
      const chk = opt.value === d.data_mode ? ' checked' : '';
      return '<label class="mode-option' + sel + '">'
        + '<input type="radio" name="cheerMode" value="' + escapeHtml(opt.value) + '"' + chk + '>'
        + '<span><span class="mode-option-title">' + escapeHtml(opt.label) + '</span>'
        + '<span class="mode-option-desc">' + (descs[opt.value] || '') + '</span></span>'
        + '</label>';
    }).join('');
    box.querySelectorAll('input[name="cheerMode"]').forEach((el) => {
      el.addEventListener('change', () => saveCheerMode(el.value));
    });
  } catch (e) { /* 分区不可见时静默 */ }
}
let cheerSwitchSaving = false;
async function saveCheerSettings() {
  if (cheerSwitchSaving) return;
  cheerSwitchSaving = true;
  const r = await api('PUT', '/api/admin/cheer/config', {
    date_context_enabled: document.getElementById('dateCtxEnabled').checked,
    humanize_enabled: document.getElementById('humanizeEnabled').checked,
    event_context_enabled: document.getElementById('eventCtxEnabled').checked,
  });
  cheerSwitchSaving = false;
  if (!r) return;
  const d = await r.json();
  if (d.ok) toast('多样性开关已保存');
  else toast(escapeHtml(d.error || '保存失败'), 'error');
}
async function saveCheerMode(mode) {
  if (mode === currentCheerMode) return;
  const r = await api('PUT', '/api/admin/cheer/config', { data_mode: mode });
  if (!r) return;
  const d = await r.json();
  if (d.ok) toast('已切换为「' + escapeHtml(d.data_mode_label || mode) + '」');
  else toast(escapeHtml(d.error || '保存失败'), 'error');
  refreshCheerMode();
}

/* ════════════════════════════════════════════════
 * 6.5 提示词配置（v1.1.0 Task 3：措辞/参数免发版热调，30s TTL 生效）
 * ════════════════════════════════════════════════ */
async function refreshPrompts() {
  try {
    const r = await api('GET', '/api/admin/cheer/prompts');
    if (!r) return;
    const d = await r.json();
    if (!d.ok) return;
    const p = d.prompts || {};
    const badge = document.getElementById('promptsVersionBadge');
    badge.textContent = d.customized ? '自定义 v' + d.version : '代码默认 v0';
    badge.className = 'badge ' + (d.customized ? 'badge-file' : 'badge-env');
    document.getElementById('promptLineCount').value = p.line_count ?? 5;
    document.getElementById('promptLineMinChars').value = p.line_min_chars ?? 20;
    document.getElementById('promptTargetRange').value = p.line_target_range ?? '30-50';
    document.getElementById('promptCandidateCount').value = p.candidate_count ?? 1;
    document.getElementById('promptFreqPenalty').value = p.frequency_penalty ?? 0;
    document.getElementById('promptPresPenalty').value = p.presence_penalty ?? 0;
    document.getElementById('promptEventMinStrong').value = p.event_min_lines_strong ?? 1;
    document.getElementById('promptEventMinPreview').value = p.event_min_lines_preview ?? 1;
    document.getElementById('promptStrongHint').value = p.event_strong_hint || '';
    document.getElementById('promptPreviewHint').value = p.event_preview_hint || '';
    document.getElementById('promptDateHint').value = p.date_context_hint || '';
    document.getElementById('promptFewShot').value = (p.few_shot_examples || []).join('\n');
  } catch (e) { /* 分区不可见时静默 */ }
}
function collectPromptsBody() {
  const num = (id, fallback) => {
    const v = Number(document.getElementById(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  const fewShot = document.getElementById('promptFewShot').value.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    line_count: num('promptLineCount', 5),
    line_min_chars: num('promptLineMinChars', 20),
    line_target_range: document.getElementById('promptTargetRange').value.trim(),
    candidate_count: num('promptCandidateCount', 1),
    frequency_penalty: num('promptFreqPenalty', 0),
    presence_penalty: num('promptPresPenalty', 0),
    event_min_lines_strong: num('promptEventMinStrong', 1),
    event_min_lines_preview: num('promptEventMinPreview', 1),
    event_strong_hint: document.getElementById('promptStrongHint').value,
    event_preview_hint: document.getElementById('promptPreviewHint').value,
    date_context_hint: document.getElementById('promptDateHint').value,
    few_shot_examples: fewShot,
  };
}
async function savePrompts() {
  const btn = document.getElementById('savePromptsBtn');
  const result = document.getElementById('promptsResult');
  btn.disabled = true;
  result.textContent = '保存中…';
  try {
    const r = await api('PUT', '/api/admin/cheer/prompts', collectPromptsBody());
    if (!r) { result.textContent = ''; return; }
    const d = await r.json();
    if (d.ok) {
      result.textContent = '';
      toast('提示词已保存，30s 内生效（当前 v' + escapeHtml(String(d.version)) + '）');
      refreshPrompts();
    } else {
      // 校验失败详情（非法占位符/数值越界）直接展示在面板内，方便定位
      result.textContent = d.error || '保存失败';
      toast('提示词校验失败，见面板下方详情', 'error');
    }
  } catch (e) {
    result.textContent = '网络错误：' + e.message;
  } finally {
    btn.disabled = false;
  }
}
async function resetPrompts() {
  const ok = await confirmDanger('恢复默认提示词', '将删除后台自定义配置，回到代码内置模板（version 归 0）。确认恢复？');
  if (!ok) return;
  const r = await api('DELETE', '/api/admin/cheer/prompts');
  if (!r) return;
  const d = await r.json();
  if (d.ok) {
    toast('已恢复代码默认模板');
    refreshPrompts();
  } else {
    toast(escapeHtml(d.error || '恢复失败'), 'error');
  }
}

/* ════════════════════════════════════════════════
 * 7. 应援事件管理
 * ════════════════════════════════════════════════ */
const EVT_TYPE_LABEL = { gold_medal: '金牌赛', match: '比赛', festival: '节日' };
let eventBeingEdited = null;
async function refreshEvents() {
  const el = document.getElementById('eventList');
  try {
    const r = await api('GET', '/api/admin/cheer/events');
    if (!r) return;
    const d = await r.json();
    if (!d.ok) {
      el.innerHTML = '<div class="result error result--flush">加载失败：' + escapeHtml(d.error || '未知错误')
        + '<button class="btn btn-ghost btn-sm" type="button" data-action="reload">重试</button></div>';
      return;
    }
    const events = d.events || [];
    if (!events.length) {
      el.innerHTML = '<div class="empty">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>'
        + '<p class="empty-title">暂无应援事件</p>'
        + '<p class="empty-desc">添加赛事或节日后，命中预告窗口会自动注入文案与倒计时</p>'
        + '<button class="btn btn-primary btn-sm" type="button" data-action="add">新增事件</button>'
        + '</div>';
      updateOverviewEvents([]);
      return;
    }
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    el.innerHTML = events.map((ev) => {
      const daysUntil = diffDays(todayStr, ev.date);
      const inWindow = ev.active !== false && daysUntil >= 0 && daysUntil <= (ev.leadDays ?? 30);
      const status = !ev.active
        ? '<span class="badge badge--muted">已停用</span>'
        : inWindow
          ? '<span class="badge badge--live">命中中 · 剩 ' + daysUntil + ' 天</span>'
          : daysUntil < 0
            ? '<span class="badge badge--expired">已过期</span>'
            : '<span class="badge badge--upcoming">未开始 · ' + daysUntil + ' 天后</span>';
      const parts = (ev.date || '').split('-');
      const md = parts.length === 3 ? (parts[1] + '-' + parts[2]) : (ev.date || '-');
      const y = parts.length === 3 ? parts[0] : '';
      return '<div class="event-row" data-id="' + escapeHtml(ev._id) + '">'
        + '<div class="event-date-chip"><span class="d">' + escapeHtml(md) + '</span><span class="y">' + escapeHtml(y) + '</span></div>'
        + '<div>'
        + '<div class="event-line1"><span class="event-title">' + escapeHtml(ev.title) + '</span>' + status + '</div>'
        + '<div class="event-meta">预告窗口 ' + escapeHtml(String(ev.leadDays ?? 30)) + ' 天 · ' + escapeHtml(EVT_TYPE_LABEL[ev.type] || '比赛') + '</div>'
        + (ev.description ? '<div class="event-desc">' + escapeHtml(ev.description) + '</div>' : '')
        + '</div>'
        + '<div class="event-actions">'
        + '<button class="btn btn-ghost btn-sm" type="button" data-action="edit">' + ICONS.edit + '编辑</button>'
        + '<button class="btn btn-danger-ghost btn-sm" type="button" data-action="del">' + ICONS.trash + '删除</button>'
        + '</div>'
        + '</div>';
    }).join('');
    updateOverviewEvents(events);
  } catch (e) {
    el.innerHTML = '<div class="result error result--flush">网络错误：' + escapeHtml(e.message) + '</div>';
  }
}
function updateOverviewEvents(events) {
  const active = events.filter((e) => e.active !== false);
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
  const live = active.find((e) => { const du = diffDays(todayStr, e.date); return du >= 0 && du <= (e.leadDays ?? 30); });
  const upcoming = active
    .filter((e) => diffDays(todayStr, e.date) > 0)
    .sort((a, b) => diffDays(todayStr, a.date) - diffDays(todayStr, b.date))[0];
  const titleEl = document.getElementById('ovEventTitle');
  const subEl = document.getElementById('ovEventSub');
  if (live) {
    titleEl.textContent = live.title;
    subEl.textContent = '命中中，剩 ' + diffDays(todayStr, live.date) + ' 天';
  } else if (upcoming) {
    titleEl.textContent = upcoming.title;
    subEl.textContent = diffDays(todayStr, upcoming.date) + ' 天后开始';
  } else if (active.length) {
    titleEl.textContent = active[0].title;
    subEl.textContent = '当前无命中窗口';
  } else {
    titleEl.textContent = '暂无事件';
    subEl.textContent = '添加后自动注入文案与倒计时';
  }
}
function fillEventForm(ev) {
  document.getElementById('evtId').value = ev._id || '';
  document.getElementById('evtDate').value = ev.date || '';
  document.getElementById('evtTitle').value = ev.title || '';
  document.getElementById('evtLeadDays').value = ev.leadDays ?? 30;
  document.getElementById('evtType').value = ev.type || 'match';
  document.getElementById('evtDesc').value = ev.description || '';
  document.getElementById('evtActive').checked = ev.active !== false;
  document.getElementById('eventFormTitle').textContent = ev._id ? '编辑事件' : '新增事件';
}
function openEventForm(ev) {
  fillEventForm(ev || { leadDays: 30, type: 'match', active: true });
  document.getElementById('eventFormWrap').hidden = false;
  document.getElementById('evtDate').focus();
}
function resetEventForm() {
  eventBeingEdited = null;
  fillEventForm({ leadDays: 30, type: 'match', active: true });
  document.getElementById('eventFormWrap').hidden = true;
}
function editEvent(id) {
  eventBeingEdited = id;
  api('GET', '/api/admin/cheer/events').then(async (r) => {
    if (!r) return;
    const d = await r.json();
    const ev = (d.events || []).find((e) => e._id === id);
    if (ev) {
      openEventForm(ev);
      eventBeingEdited = id;
    }
  });
}
async function saveEvent() {
  const date = document.getElementById('evtDate').value.trim();
  const title = document.getElementById('evtTitle').value.trim();
  if (!date || !title) { toast('日期和标题为必填项', 'error'); return; }
  const leadDays = Number(document.getElementById('evtLeadDays').value);
  const body = {
    _id: eventBeingEdited || document.getElementById('evtId').value || undefined,
    date,
    title,
    leadDays: Number.isInteger(leadDays) && leadDays >= 0 ? leadDays : 30,
    type: document.getElementById('evtType').value,
    description: document.getElementById('evtDesc').value.trim(),
    active: document.getElementById('evtActive').checked,
  };
  const btn = document.getElementById('eventSaveBtn');
  btn.disabled = true;
  const r = await api('PUT', '/api/admin/cheer/events', body);
  btn.disabled = false;
  if (!r) return;
  const d = await r.json();
  if (d.ok) {
    toast(escapeHtml(d.message || '事件已保存'));
    resetEventForm();
    refreshEvents();
  } else {
    toast(escapeHtml(d.error || '保存失败'), 'error');
  }
}
async function deleteEvent(id) {
  const ok = await confirmDanger('删除应援事件', '删除后立即失效，文案注入与倒计时随之停止。确认删除该事件？');
  if (!ok) return;
  const r = await api('DELETE', '/api/admin/cheer/events/' + encodeURIComponent(id));
  if (!r) return;
  const d = await r.json();
  if (d.ok) {
    toast(escapeHtml(d.message || '事件已删除'));
    resetEventForm();
    refreshEvents();
  } else {
    toast(escapeHtml(d.error || '删除失败'), 'error');
  }
}

/* ════════════════════════════════════════════════
 * 8. 数据采集与定时任务
 * ════════════════════════════════════════════════ */
async function refreshSyncStatus() {
  const el = document.getElementById('syncStatus');
  try {
    const r = await api('GET', '/api/admin/sync/status');
    if (!r) return;
    const d = await r.json();
    if (!d.ok) {
      el.innerHTML = '<div class="result error result--flush">加载失败：' + escapeHtml(d.error || '未知错误') + '</div>';
      return;
    }
    let html = '';
    if (d.last_daily_sync) {
      html += '<div class="sync-block"><b>单人数据</b> ' + statusBadge(d.last_daily_sync.status)
        + ' <span class="dim">赛季 ' + escapeHtml(d.last_daily_sync.season || '-') + '</span><br>'
        + '<span class="muted-12">上次更新 ' + formatTime(d.last_daily_sync.updated_at) + '</span>'
        + (d.last_daily_sync.error ? '<br><span class="text-error-12">错误：' + escapeHtml(d.last_daily_sync.error) + '</span>' : '')
        + '</div>';
    } else {
      html += '<div class="sync-block"><b>单人数据</b> <span class="muted-12">暂无记录</span></div>';
    }
    if (d.last_schedule_sync) {
      html += '<div class="sync-block"><b>赛程数据</b> ' + statusBadge(d.last_schedule_sync.status)
        + ' <span class="dim">赛季 ' + escapeHtml(d.last_schedule_sync.season || '-') + '</span><br>'
        + '<span class="muted-12">上次更新 ' + formatTime(d.last_schedule_sync.updated_at) + '</span>'
        + (d.last_schedule_sync.error ? '<br><span class="text-error-12">错误：' + escapeHtml(d.last_schedule_sync.error) + '</span>' : '')
        + '</div>';
    } else {
      html += '<div class="sync-block"><b>赛程数据</b> <span class="muted-12">暂无记录</span></div>';
    }
    if (d.player_overview) {
      const p = d.player_overview;
      const cs = p.current_season || {};
      html += '<div class="overview">'
        + '<div class="overview__name">' + escapeHtml(p.player_name || '-') + ' <span class="muted-12">' + escapeHtml(p.team_name || '') + '</span></div>'
        + '<div class="overview__meta">'
        + '赛季：' + escapeHtml(p.season_name || p.season || '-') + '<br>'
        + '最后比赛：' + escapeHtml(p.latest_match_time || '-') + '<br>'
        + '当前赛季：' + escapeHtml(String(cs.battles || 0)) + ' 场 / ' + escapeHtml(String(cs.wins || 0)) + '胜' + escapeHtml(String(cs.loses || 0)) + '负'
        + (cs.win_rate ? '（' + escapeHtml(cs.win_rate) + '）' : '')
        + (cs.mvp ? ' / MVP ' + escapeHtml(String(cs.mvp)) : '')
        + (cs.kda_ratio ? ' / KDA ' + escapeHtml(String(cs.kda_ratio)) : '')
        + '<br><span class="muted-12">数据入库时间 ' + formatTime(p.updated_at) + '</span>'
        + '</div></div>';
    }
    el.innerHTML = html;

    const hasErr = (d.last_daily_sync && d.last_daily_sync.status === 'error')
      || (d.last_schedule_sync && d.last_schedule_sync.status === 'error');
    document.getElementById('navSyncDot').hidden = !hasErr;

    document.getElementById('ovSyncDaily').innerHTML = d.last_daily_sync ? statusBadge(d.last_daily_sync.status) : '<span class="muted-12">暂无</span>';
    document.getElementById('ovSyncSchedule').innerHTML = d.last_schedule_sync ? statusBadge(d.last_schedule_sync.status) : '<span class="muted-12">暂无</span>';
    document.getElementById('ovSyncTime').textContent = d.last_daily_sync ? formatTime(d.last_daily_sync.updated_at) : '-';

    const scheduleEl = document.getElementById('scheduleList');
    if (Array.isArray(d.schedules)) {
      const colls = d.schedules.filter((s) => s.category === 'collection');
      if (colls.length > 0) {
        scheduleEl.innerHTML = colls.map((s) => '<div class="schedule-item">'
          + '<b>' + escapeHtml(s.name) + '</b> <span class="cron-code">' + escapeHtml(s.cron) + '</span><br>'
          + '<span class="dim">' + escapeHtml(s.description) + '</span>'
          + (s.next_run ? '<br><span class="ok-text fs-12">下次执行 ' + formatTimeCST(s.next_run) + '</span>' : '')
          + '</div>').join('');
      } else {
        scheduleEl.innerHTML = '<span class="muted-12">无采集任务</span>';
      }
    }
  } catch (e) {
    el.innerHTML = '<div class="result error result--flush">网络错误：' + escapeHtml(e.message) + '</div>';
  }
}
async function triggerCrawl() {
  const el = document.getElementById('crawlResult');
  const btn = document.getElementById('crawlBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>提交中…';
  el.innerHTML = '<div class="result info">采集任务已提交，异步执行中，结果见容器日志…</div>';
  try {
    const r = await api('POST', '/api/admin/sync/crawl');
    if (!r) { btn.disabled = false; btn.innerHTML = '手动采集'; return; }
    const d = await r.json();
    el.innerHTML = d.ok
      ? '<div class="result success">' + escapeHtml(d.message) + '</div>'
      : '<div class="result error">' + escapeHtml(d.error || '触发失败') + '</div>';
  } catch (e) {
    el.innerHTML = '<div class="result error">网络错误：' + escapeHtml(e.message) + '</div>';
  }
  btn.disabled = false;
  btn.innerHTML = '手动采集';
}

const CRAWL_PRESETS = ['0 9 * * *', '0 9,21 * * *', '0 3,9,15,21 * * *'];
function onCrawlPresetChange() {
  const val = document.getElementById('crawlPreset').value;
  document.getElementById('crawlCustomGroup').hidden = (val !== 'custom');
}
async function refreshSchedulerConfig() {
  try {
    const r = await api('GET', '/api/admin/scheduler/config');
    if (!r) return;
    const d = await r.json();
    if (!d.ok) return;
    const badge = document.getElementById('schedulerSourceBadge');
    badge.textContent = d.source === 'db' ? '已自定义' : '默认值';
    badge.className = 'badge ' + (d.source === 'db' ? 'badge-file' : 'badge-env');
    document.getElementById('weeklyStoryEnabled').checked = !!d.weekly_story_enabled;
    const sel = document.getElementById('crawlPreset');
    const crawlGroup = document.getElementById('crawlCustomGroup');
    if (CRAWL_PRESETS.includes(d.kpl_crawl_cron)) {
      sel.value = d.kpl_crawl_cron;
      crawlGroup.hidden = true;
    } else {
      sel.value = 'custom';
      crawlGroup.hidden = false;
      document.getElementById('crawlCustomCron').value = d.kpl_crawl_cron;
    }
    const crawl = Array.isArray(d.schedules) ? d.schedules.find((s) => s.key === 'kpl_crawl') : null;
    const nextTxt = crawl && crawl.next_run ? '采集任务下次执行：' + formatTimeCST(crawl.next_run) : '';
    document.getElementById('schedulerNextRun').textContent = nextTxt;
    document.getElementById('ovTaskNext').textContent = crawl && crawl.next_run ? formatTimeCST(crawl.next_run) : '-';
    const wk = document.getElementById('ovTaskWeekly');
    wk.textContent = d.weekly_story_enabled ? '已开启' : '已关闭';
    wk.className = d.weekly_story_enabled ? 'ok-text' : 'muted-12';
  } catch (e) { /* 静默 */ }
}
async function saveSchedulerConfig() {
  const body = { weekly_story_enabled: document.getElementById('weeklyStoryEnabled').checked };
  const preset = document.getElementById('crawlPreset').value;
  body.kpl_crawl_cron = preset === 'custom'
    ? document.getElementById('crawlCustomCron').value.trim()
    : preset;
  if (!body.kpl_crawl_cron) { toast('cron 不能为空', 'error'); return; }
  const btn = document.getElementById('saveSchedulerBtn');
  btn.disabled = true;
  const r = await api('PUT', '/api/admin/scheduler/config', body);
  btn.disabled = false;
  if (!r) return;
  const d = await r.json();
  if (d.ok) {
    toast(escapeHtml(d.message || '定时任务配置已保存'));
    document.getElementById('schedulerNextRun').textContent =
      d.next_run ? '采集任务下次执行：' + formatTimeCST(d.next_run) : '';
    document.getElementById('ovTaskNext').textContent = d.next_run ? formatTimeCST(d.next_run) : '-';
    refreshSyncStatus();
  } else {
    toast(escapeHtml(d.error || '保存失败'), 'error');
  }
}

/* ════════════════════════════════════════════════
 * 9. 总览
 * ════════════════════════════════════════════════ */
let ovRefreshing = false;
async function refreshOverview() {
  if (ovRefreshing) return;
  ovRefreshing = true;
  const btn = document.getElementById('ovRefresh');
  btn.disabled = true;
  await Promise.allSettled([refresh(), refreshCheerMode(), refreshEvents(), refreshSyncStatus(), refreshSchedulerConfig()]);
  btn.disabled = false;
  ovRefreshing = false;
}
function refreshCheerSection() { refreshCheerMode(); refreshEvents(); refreshPrompts(); }
function refreshSyncSection() { refreshSyncStatus(); refreshSchedulerConfig(); }

/* ════════════════════════════════════════════════
 * 10. 事件绑定与初始化
 * ════════════════════════════════════════════════ */
function bindEvents() {
  document.getElementById('loginForm').addEventListener('submit', doLogin);
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  document.getElementById('logoutBtnM').addEventListener('click', doLogout);
  document.getElementById('ovRefresh').addEventListener('click', refreshOverview);

  document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
  document.getElementById('testAiBtn').addEventListener('click', testAI);
  document.getElementById('fetchModelsBtn').addEventListener('click', fetchModelList);
  document.getElementById('curModelsBtn').addEventListener('click', fetchModelsForCurrent);

  document.getElementById('dateCtxEnabled').addEventListener('change', saveCheerSettings);
  document.getElementById('humanizeEnabled').addEventListener('change', saveCheerSettings);
  document.getElementById('eventCtxEnabled').addEventListener('change', saveCheerSettings);

  document.getElementById('savePromptsBtn').addEventListener('click', savePrompts);
  document.getElementById('resetPromptsBtn').addEventListener('click', resetPrompts);

  document.getElementById('eventAddBtn').addEventListener('click', () => { eventBeingEdited = null; openEventForm(); });
  document.getElementById('eventCancelBtn').addEventListener('click', resetEventForm);
  document.getElementById('eventCloseBtn').addEventListener('click', resetEventForm);
  document.getElementById('eventSaveBtn').addEventListener('click', saveEvent);
  document.getElementById('eventList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'add') { eventBeingEdited = null; openEventForm(); return; }
    if (action === 'reload') { refreshEvents(); return; }
    const row = btn.closest('.event-row');
    const id = row ? row.dataset.id : '';
    if (action === 'edit') editEvent(id);
    if (action === 'del') deleteEvent(id);
  });

  document.getElementById('crawlBtn').addEventListener('click', triggerCrawl);
  document.getElementById('refreshBtn').addEventListener('click', refreshSyncStatus);
  document.getElementById('crawlPreset').addEventListener('change', onCrawlPresetChange);
  document.getElementById('saveSchedulerBtn').addEventListener('click', saveSchedulerConfig);
  document.getElementById('reloadSchedulerBtn').addEventListener('click', refreshSchedulerConfig);

  document.addEventListener('click', (e) => {
    const box = document.getElementById('modelPicker');
    const btn = document.getElementById('fetchModelsBtn');
    if (box && !box.hidden && !box.contains(e.target) && !btn.contains(e.target)) hideModelPicker();
    const cbox = document.getElementById('curModelPicker');
    const cbtn = document.getElementById('curModelsBtn');
    if (cbox && !cbox.hidden && !cbox.contains(e.target) && !cbtn.contains(e.target)) hideCurrentModelPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideModelPicker(); hideCurrentModelPicker(); }
  });
}

(async function init() {
  bindEvents();
  const t = getToken();
  if (!t) { showLogin(); return; }
  try {
    const r = await fetch('/api/admin/ai/config', { headers: authHeaders() });
    if (r.status === 401) { clearToken(); showLogin(); return; }
    showAdmin();
  } catch (e) {
    const banner = document.getElementById('bootError');
    banner.hidden = false;
    banner.style.display = '';
    showLogin();
  }
})();
