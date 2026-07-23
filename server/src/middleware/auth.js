'use strict';

/**
 * JWT 鉴权中间件 — 替代 CloudBase Auth
 * 适用于需要鉴权的路由（ai-cheer、ask、checkin 等）
 */

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { normalizeClientId } = require('../utils/helpers');

/**
 * Express 鉴权中间件
 * 支持两种鉴权方式：
 * 1. JWT Bearer token（本地签发验证）
 * 2. 旧版 Query Token（兼容过渡期）
 *
 * 成功时将 identity 信息挂到 req.identity
 */
function authMiddleware(req, res, next) {
  // 1. JWT Bearer token
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/iu);
  if (match) {
    const token = match[1].trim();
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      req.identity = { ok: true, kind: 'session', subjectId: payload.sub };
      return next();
    } catch (_) {
      /* invalid token, fall through to legacy */
    }
  }

  // 2. 旧版 Query Token
  const legacyToken = req.query?.token || req.body?.token || '';
  if (config.authToken && legacyToken === config.authToken) {
    const legacyId = req.body?._cid || req.body?.client_id || req.query?.client_id || 'legacy';
    req.identity = { ok: true, kind: 'legacy', subjectId: `legacy:${normalizeClientId(legacyId)}` };
    return next();
  }

  // 无有效身份
  req.identity = { ok: false };
  return next();
}

module.exports = authMiddleware;
