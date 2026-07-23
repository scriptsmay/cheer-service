'use strict';

/**
 * 内容安全中间件 — 移植自 ai-utils.js isContentBlocked
 * 检查请求中的文本内容是否包含被阻止的敏感词
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
 * Express 中间件：对 POST 请求体中的 text/q 字段做内容安全检查
 */
function contentFilterMiddleware(req, res, next) {
  if (req.method !== 'POST') return next();

  const text = req.body?.text || req.body?.q || '';
  if (text && isContentBlocked(text)) {
    return res.status(451).json({
      code: 451,
      message: '内容未通过安全检查',
    });
  }

  next();
}

module.exports = { isContentBlocked, contentFilterMiddleware };
