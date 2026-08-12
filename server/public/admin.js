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
  refreshCheerMode();
  refreshSchedulerConfig();
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

// ── 格式化时间（固定 Asia/Shanghai，不受浏览器时区影响）──
function formatTimeCST(isoStr) {
  if (!isoStr) return '-';
  try {
    return new Date(isoStr).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
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

    // ── 定时采集任务（仅展示 collection 类）──
    const scheduleEl = document.getElementById('scheduleList');
    if (Array.isArray(d.schedules)) {
      const colls = d.schedules.filter((s) => s.category === 'collection');
      if (colls.length > 0) {
        let schHtml = '';
        for (const s of colls) {
          schHtml += '<div style="font-size:12px;line-height:1.7;margin-bottom:8px">'
            + '<b>' + s.name + '</b> '
            + '<span style="color:#6366f1;font-family:monospace;font-size:11px">' + s.cron + '</span><br>'
            + '<span style="color:#888">' + s.description + '</span>'
            + (s.next_run ? '<br><span style="color:#16a34a">下次执行: ' + formatTimeCST(s.next_run) + '</span>' : '')
            + '</div>';
        }
        scheduleEl.innerHTML = schHtml;
      } else {
        scheduleEl.innerHTML = '<span style="color:#888;font-size:12px">无采集任务</span>';
      }
    }
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
  document.getElementById('crawlCustomGroup').style.display = val === 'custom' ? 'block' : 'none';
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
  if (CRAWL_PRESETS.includes(d.kpl_crawl_cron)) {
    sel.value = d.kpl_crawl_cron;
    document.getElementById('crawlCustomGroup').style.display = 'none';
  } else {
    sel.value = 'custom';
    document.getElementById('crawlCustomGroup').style.display = 'block';
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

(async function init() {
  const t = getToken();
  if (!t) { showLogin(); return; }
  // 用已有 token 尝试拉配置，失败就跳登录
  const r = await fetch(API + '/config', { headers: authHeaders() });
  if (r.status === 401) { clearToken(); showLogin(); return; }
  setToken(t);
  showAdmin();
})();
