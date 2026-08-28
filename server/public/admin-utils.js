/* ============================================================
 * admin-utils.js — 管理后台通用工具库（纯函数 / 全局）
 * 先于 admin.js 加载。仅放置无业务状态依赖的基础能力，
 * 便于在 admin.js 各功能模块间复用，也便于单测。
 * ============================================================ */

/* ── Token 存储 ── */
const TOKEN_KEY = 'wuyan_admin_token';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

/* ── 请求头 ── */
function authHeaders() {
  const t = getToken();
  return t
    ? { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

/* ── API 封装（自动处理 401 → 跳登录）── */
async function api(method, path, body) {
  const headers = authHeaders();
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) { clearToken(); showLogin(); return null; }
  return r;
}

/* ── 时间格式化（浏览器本地时区）── */
function formatTime(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  } catch { return isoStr; }
}

/* ── 时间格式化（固定 Asia/Shanghai，不受浏览器时区影响）── */
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

/* ── HTML 转义（用于插入文本内容）── */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ── 单引号字符串转义（用于 onclick="fn('...')" 内联调用）── */
function escapeJsString(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/* ── 日期差（按 +08:00 计算天数）── */
function diffDays(a, b) {
  const da = new Date(a + 'T00:00:00+08:00');
  const db = new Date(b + 'T00:00:00+08:00');
  return Math.round((db - da) / 86400000);
}

/* ── 采集状态徽章（class 化，避免内联样式）── */
function statusBadge(status) {
  const map = {
    success:   'badge--success',
    no_change: 'badge--nochange',
    skipped:   'badge--skipped',
    error:     'badge--error',
  };
  const cls = map[status] || 'badge--unknown';
  const label = {
    success: '成功', no_change: '无变化', skipped: '跳过', error: '失败',
  }[status] || (status || '未知');
  return '<span class="badge ' + cls + '">' + label + '</span>';
}
