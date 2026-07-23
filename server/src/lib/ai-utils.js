'use strict';

/**
 * ai-utils.js — 从 functions/lib/ai-utils.js 直接移植
 * 内容安全过滤 + 胜率格式化
 */

const config = require('../config/env');
const DEFAULT_BLOCKED_PATTERNS = [/自杀/u, /博彩/u, /色情/u, /仇恨/u];

/**
 * 检查文本是否包含被阻止的内容
 * @param {string} text
 * @returns {boolean}
 */
function isContentBlocked(text) {
  if (typeof text !== 'string' || !text) return false;
  return (
    config.blockedTerms.some((term) => text.includes(term)) ||
    DEFAULT_BLOCKED_PATTERNS.some((pattern) => pattern.test(text))
  );
}

/**
 * 格式化胜率为 xx.x%
 * @param {*} v
 * @returns {string}
 */
function fmtRate(v) {
  if (v === null || v === undefined) return '暂无';
  if (typeof v === 'string') {
    if (v.includes('%')) return v;
    var n = parseFloat(v);
    if (!isNaN(n) && n <= 1) return (n * 100).toFixed(1) + '%';
    return v;
  }
  if (typeof v === 'number') {
    if (v <= 1) return (v * 100).toFixed(1) + '%';
    return v.toFixed(1) + '%';
  }
  return String(v);
}

module.exports = { isContentBlocked, fmtRate };
