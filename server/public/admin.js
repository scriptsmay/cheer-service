/* ============================================================
 * admin.js — Wuyan Cheer 管理后台交互逻辑
 * 通用工具（token / api / 时间格式化 / 转义 / statusBadge 等）
 * 已抽到 admin-utils.js。本文件只保留各功能模块。
 * ============================================================ */

const API = '/api/admin/ai';

// ── 面板切换 ──
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
  refreshCheerMode();
  refreshSchedulerConfig();
  refreshEvents();
}

// ── 登录 ──
async function doLogin() {
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value.trim();
  const el = document.getElementById('loginMsg');
  if (!user || !pass) { el.innerHTML = '<div class="result error">请输入用户名和密码</div>'; return; }
  el.innerHTML = '<div class="result info"><span class="spinner"></span>登录中...</div>';

  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
    const d = await r.json();
    if (!r.ok || !d.data || !d.data.access_token) {
      el.innerHTML = '<div class="result error">❌ ' + (d.message || '登录失败') + '</div>';
      return;
    }
    setToken(d.data.access_token);
    el.innerHTML = '';
    showAdmin();
  } catch (e) {
    el.innerHTML = '<div class="result error">❌ 网络错误: ' + e.message + '</div>';
  }
}

// 回车登录
document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && document.getElementById('loginPanel').classList.contains('show')) {
    doLogin();
  }
});

// ── 登出 ──
function doLogout() {
  clearToken();
  showLogin();
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

// ── 刷新采集状态 ──
async function refreshSyncStatus() {
  const el = document.getElementById('syncStatus');
  el.innerHTML = '<div class="loading">⏳ 加载中...</div>';
  try {
    const r = await api('GET', '/api/admin/sync/status');
    if (!r) return;
    const d = await r.json();
    if (!d.ok) {
      el.innerHTML = '<div class="result error result--flush">❌ ' + (d.error || '加载失败') + '</div>';
      return;
    }

    let html = '';

    if (d.last_daily_sync) {
      html += '<div class="sync-block"><b>📊 单人数据:</b> '
        + statusBadge(d.last_daily_sync.status)
        + ' <span class="dim">赛季: ' + (d.last_daily_sync.season || '-') + '</span><br>'
        + '<span class="muted-12">上次更新: ' + formatTime(d.last_daily_sync.updated_at) + '</span>'
        + (d.last_daily_sync.error ? '<br><span class="text-error-12">错误: ' + d.last_daily_sync.error + '</span>' : '')
        + '</div>';
    } else {
      html += '<div class="sync-block"><b>📊 单人数据:</b> <span class="muted">暂无记录</span></div>';
    }

    if (d.last_schedule_sync) {
      html += '<div class="sync-block"><b>📅 赛程数据:</b> '
        + statusBadge(d.last_schedule_sync.status)
        + ' <span class="dim">赛季: ' + (d.last_schedule_sync.season || '-') + '</span><br>'
        + '<span class="muted-12">上次更新: ' + formatTime(d.last_schedule_sync.updated_at) + '</span>'
        + (d.last_schedule_sync.error ? '<br><span class="text-error-12">错误: ' + d.last_schedule_sync.error + '</span>' : '')
        + '</div>';
    } else {
      html += '<div class="sync-block"><b>📅 赛程数据:</b> <span class="muted">暂无记录</span></div>';
    }

    if (d.player_overview) {
      const p = d.player_overview;
      const cs = p.current_season || {};
      html += '<div class="overview">'
        + '<div class="overview__name">👤 ' + (p.player_name || '-')
        + ' <span class="muted">' + (p.team_name || '') + '</span></div>'
        + '<div class="overview__meta">'
        + '赛季: ' + (p.season_name || p.season || '-') + '<br>'
        + '最后比赛: ' + (p.latest_match_time || '-') + '<br>'
        + '当前赛季: ' + (cs.battles || 0) + ' 场 / ' + (cs.wins || 0) + '胜' + (cs.loses || 0) + '负'
        + (cs.win_rate ? ' (' + cs.win_rate + ')' : '')
        + (cs.mvp ? ' / MVP: ' + cs.mvp : '')
        + (cs.kda_ratio ? ' / KDA: ' + cs.kda_ratio : '')
        + '<br>'
        + '<span class="muted-12">数据入库时间: ' + formatTime(p.updated_at) + '</span>'
        + '</div></div>';
    }

    el.innerHTML = html;

    // ── 定时采集任务（仅展示 collection 类）──
    const scheduleEl = document.getElementById('scheduleList');
    if (Array.isArray(d.schedules)) {
      const colls = d.schedules.filter((s) => s.category === 'collection');
      if (colls.length > 0) {
        let schHtml = '';
        for (const s of colls) {
          schHtml += '<div class="schedule-item">'
            + '<b>' + s.name + '</b> '
            + '<span class="cron-code">' + s.cron + '</span><br>'
            + '<span class="dim-12">' + s.description + '</span>'
            + (s.next_run ? '<br><span class="text-green-12">下次执行: ' + formatTimeCST(s.next_run) + '</span>' : '')
            + '</div>';
        }
        scheduleEl.innerHTML = schHtml;
      } else {
        scheduleEl.innerHTML = '<span class="muted-12">无采集任务</span>';
      }
    }
  } catch (e) {
    el.innerHTML = '<div class="result error result--flush">❌ 网络错误: ' + e.message + '</div>';
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
  } catch (e) {
    el.innerHTML = '<div class="result error">❌ 网络错误: ' + e.message + '</div>';
  }
  btn.disabled = false;
  btn.innerHTML = '🔄 手动采集';
}

// ── 应援文案数据模式 ──
let currentCheerMode = 'season';

async function refreshCheerMode() {
  const r = await api('GET', '/api/admin/cheer/config');
  if (!r) return;
  const d = await r.json();
  if (!d.ok) return;
  currentCheerMode = d.data_mode;

  const badge = document.getElementById('cheerModeSourceBadge');
  badge.textContent = d.source === 'db' ? '已自定义' : '环境变量默认';
  badge.className = 'badge ' + (d.source === 'db' ? 'badge-file' : 'badge-env');

  // 三个多样性开关
  document.getElementById('dateCtxEnabled').checked = d.date_context_enabled !== false;
  document.getElementById('humanizeEnabled').checked = d.humanize_enabled !== false;
  document.getElementById('eventCtxEnabled').checked = d.event_context_enabled !== false;

  const box = document.getElementById('cheerModeOptions');
  const descs = {
    season: '注入「当前赛季」战绩（KDA、胜率、对局数、MVP、常用英雄）',
    career: '注入「生涯」汇总数据，并禁止前瞻性赛程表述（适用于选手缺赛期）',
    emotion: '不注入任何数据，生成纯情绪应援文案',
  };
  box.innerHTML = (d.options || []).map((opt) => {
    const selected = opt.value === d.data_mode ? ' selected' : '';
    const checked = opt.value === d.data_mode ? ' checked' : '';
    const desc = descs[opt.value] || '';
    return '<label class="mode-option' + selected + '">'
      + '<input type="radio" name="cheerMode" value="' + opt.value + '"' + checked + '>'
      + '<span><b class="mode-option-title">' + opt.label + '</b><br>'
      + '<span class="mode-option-desc">' + desc + '</span></span>'
      + '</label>';
  }).join('');

  box.querySelectorAll('input[name="cheerMode"]').forEach((el) => {
    el.addEventListener('change', () => saveCheerMode(el.value));
  });
}

// ── 保存多样性开关（数据模式保持不变）──
let cheerSwitchSaving = false;
async function saveCheerSettings() {
  if (cheerSwitchSaving) return;
  cheerSwitchSaving = true;
  const el = document.getElementById('cheerModeResult');
  el.innerHTML = '<div class="result info"><span class="spinner"></span>保存中...</div>';
  const r = await api('PUT', '/api/admin/cheer/config', {
    date_context_enabled: document.getElementById('dateCtxEnabled').checked,
    humanize_enabled: document.getElementById('humanizeEnabled').checked,
    event_context_enabled: document.getElementById('eventCtxEnabled').checked,
  });
  if (!r) { cheerSwitchSaving = false; return; }
  const d = await r.json();
  el.innerHTML = d.ok
    ? '<div class="result success">✅ ' + d.message + '</div>'
    : '<div class="result error">❌ ' + (d.error || '保存失败') + '</div>';
  setTimeout(() => { el.innerHTML = ''; }, 3000);
  cheerSwitchSaving = false;
}

async function saveCheerMode(mode) {
  if (mode === currentCheerMode) return;
  const el = document.getElementById('cheerModeResult');
  el.innerHTML = '<div class="result info"><span class="spinner"></span>保存中...</div>';
  const r = await api('PUT', '/api/admin/cheer/config', { data_mode: mode });
  if (!r) return;
  const d = await r.json();
  el.innerHTML = d.ok
    ? '<div class="result success">✅ 已切换为「' + d.data_mode_label + '」，' + d.message + '</div>'
    : '<div class="result error">❌ ' + (d.error || '保存失败') + '</div>';
  refreshCheerMode();
}

// ── 定时任务配置 ──
const CRAWL_PRESETS = ['0 9 * * *', '0 9,21 * * *', '0 3,9,15,21 * * *'];

function onCrawlPresetChange() {
  const val = document.getElementById('crawlPreset').value;
  document.getElementById('crawlCustomGroup').classList.toggle('hidden', val !== 'custom');
}

async function refreshSchedulerConfig() {
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
    crawlGroup.classList.add('hidden');
  } else {
    sel.value = 'custom';
    crawlGroup.classList.remove('hidden');
    document.getElementById('crawlCustomCron').value = d.kpl_crawl_cron;
  }

  const crawl = Array.isArray(d.schedules) ? d.schedules.find((s) => s.key === 'kpl_crawl') : null;
  document.getElementById('schedulerNextRun').textContent =
    crawl && crawl.next_run ? '采集任务下次执行: ' + formatTimeCST(crawl.next_run) : '';
}

async function saveSchedulerConfig() {
  const body = { weekly_story_enabled: document.getElementById('weeklyStoryEnabled').checked };
  const preset = document.getElementById('crawlPreset').value;
  body.kpl_crawl_cron = preset === 'custom'
    ? document.getElementById('crawlCustomCron').value.trim()
    : preset;

  const el = document.getElementById('schedulerResult');
  if (!body.kpl_crawl_cron) { el.innerHTML = '<div class="result error">cron 不能为空</div>'; return; }
  el.innerHTML = '<div class="result info"><span class="spinner"></span>保存中...</div>';

  const r = await api('PUT', '/api/admin/scheduler/config', body);
  if (!r) return;
  const d = await r.json();
  if (d.ok) {
    el.innerHTML = '<div class="result success">✅ ' + d.message + '</div>';
    document.getElementById('schedulerNextRun').textContent =
      d.next_run ? '采集任务下次执行: ' + formatTimeCST(d.next_run) : '';
    refreshSyncStatus();
  } else {
    el.innerHTML = '<div class="result error">❌ ' + (d.error || '保存失败') + '</div>';
  }
}

// ── 应援事件管理 ──
let eventBeingEdited = null;

async function refreshEvents() {
  const r = await api('GET', '/api/admin/cheer/events');
  if (!r) return;
  const d = await r.json();
  const el = document.getElementById('eventList');
  if (!d.ok) {
    el.innerHTML = '<div class="result error result--flush">❌ ' + (d.error || '加载失败') + '</div>';
    return;
  }
  const events = d.events || [];
  if (!events.length) {
    el.innerHTML = '<div class="muted-13">暂无事件。可添加「王者荣耀亚运金牌赛」（2026-09-28，leadDays 30）。</div>';
    return;
  }
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

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
    return '<div class="event-row">'
      + '<div>'
      + '<div class="event-title">' + escapeHtml(ev.title)
      + ' <span class="event-date">' + (ev.date || '-') + '</span></div>'
      + '<div class="event-meta">预告窗口: ' + (ev.leadDays ?? 30) + ' 天'
      + ' · 类型: ' + (ev.type || 'match')
      + (ev.description ? ' · ' + escapeHtml(ev.description) : '') + '</div>'
      + '<div class="mt4">' + status + '</div>'
      + '</div>'
      + '<div class="btn-row btn-row--sm">'
      + '<button class="btn btn-sm btn-outline" onclick="editEvent(\'' + escapeJsString(ev._id) + '\')">✏️ 编辑</button>'
      + '<button class="btn btn-sm btn-danger" onclick="deleteEvent(\'' + escapeJsString(ev._id) + '\')">🗑 删除</button>'
      + '</div></div>';
  }).join('');
}

function fillEventForm(ev) {
  document.getElementById('evtId').value = ev._id || '';
  document.getElementById('evtDate').value = ev.date || '';
  document.getElementById('evtTitle').value = ev.title || '';
  document.getElementById('evtLeadDays').value = ev.leadDays ?? 30;
  document.getElementById('evtType').value = ev.type || 'match';
  document.getElementById('evtDesc').value = ev.description || '';
  document.getElementById('evtActive').checked = ev.active !== false;
  document.getElementById('eventFormTitle').textContent = ev._id ? '✏️ 编辑事件 #' + ev._id : '➕ 新增事件';
}

function editEvent(id) {
  eventBeingEdited = id;
  api('GET', '/api/admin/cheer/events').then(async (r) => {
    if (!r) return;
    const d = await r.json();
    const ev = (d.events || []).find((e) => e._id === id);
    if (ev) fillEventForm(ev);
  });
}

function resetEventForm() {
  eventBeingEdited = null;
  fillEventForm({ leadDays: 30, type: 'match', active: true });
  document.getElementById('eventResult').innerHTML = '';
}

async function saveEvent() {
  const el = document.getElementById('eventResult');
  const date = document.getElementById('evtDate').value.trim();
  const title = document.getElementById('evtTitle').value.trim();
  if (!date || !title) {
    el.innerHTML = '<div class="result error">日期和标题必填</div>';
    return;
  }
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
  el.innerHTML = '<div class="result info"><span class="spinner"></span>保存中...</div>';
  const r = await api('PUT', '/api/admin/cheer/events', body);
  if (!r) return;
  const d = await r.json();
  el.innerHTML = d.ok
    ? '<div class="result success">✅ ' + d.message + '</div>'
    : '<div class="result error">❌ ' + (d.error || '保存失败') + '</div>';
  if (d.ok) {
    resetEventForm();
    refreshEvents();
  }
}

async function deleteEvent(id) {
  if (!confirm('确认删除该事件？删除后立即失效。')) return;
  const r = await api('DELETE', '/api/admin/cheer/events/' + encodeURIComponent(id));
  if (!r) return;
  const d = await r.json();
  document.getElementById('eventResult').innerHTML = d.ok
    ? '<div class="result success">✅ ' + d.message + '</div>'
    : '<div class="result error">❌ ' + (d.error || '删除失败') + '</div>';
  if (d.ok) { resetEventForm(); refreshEvents(); }
}

// ── 初始化 ──
(async function init() {
  const t = getToken();
  if (!t) { showLogin(); return; }
  // 用已有 token 尝试拉配置，失败就跳登录
  const r = await fetch(API + '/config', { headers: authHeaders() });
  if (r.status === 401) { clearToken(); showLogin(); return; }
  setToken(t);
  showAdmin();
})();
