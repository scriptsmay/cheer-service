/* ============================================================
 * admin-utils.js — 管理后台通用工具库（纯函数 / 全局）
 * 自 v1.1.0 管理后台重设计拆分（原型 §1 基础工具），与旧版职责一致
 * 先于 admin.js 加载；仅放置无业务状态依赖的基础能力（token/api/格式化/图标）
 * ============================================================ */
'use strict';
/* ════════════════════════════════════════════════
 * 1. 基础工具：token 存取 / api 封装 / 格式化 / 状态徽章 / 图标
 * ════════════════════════════════════════════════ */
const TOKEN_KEY = '***'; // 与原 admin-utils.js 保持一致，避免已登录会话失效
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }
function authHeaders() {
  const t = getToken();
  return t
    ? { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { clearToken(); showLogin(); return null; }
  return r;
}
function pad(n) { return String(n).padStart(2, '0'); }
function formatTime(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  } catch { return isoStr; }
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function diffDays(a, b) {
  const da = new Date(a + 'T00:00:00+08:00');
  const db = new Date(b + 'T00:00:00+08:00');
  return Math.round((db - da) / 86400000);
}
function statusBadge(status) {
  const cls = ({
    success: 'badge--success', no_change: 'badge--nochange',
    skipped: 'badge--skipped', error: 'badge--error',
  }[status]) || 'badge--unknown badge-env';
  const label = ({ success: '成功', no_change: '无变化', skipped: '跳过', error: '失败' }[status]) || (status || '未知');
  return '<span class="badge ' + cls + '">' + label + '</span>';
}
const ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.8 3.7a2.4 2.4 0 0 1 3.4 3.4L7.5 19.8 3 21l1.2-4.5L16.8 3.7z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.8 12.5a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10 11v6M14 11v6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 5.5l6.5 6.5-6.5 6.5"/></svg>',
};
