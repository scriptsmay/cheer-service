'use strict';

/**
 * JWT 鉴权中间件 — 替代 CloudBase Auth
 * 适用于需要鉴权的路由（ai-cheer、ask、checkin 等）
 */

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { normalizeClientId, hashValue, getClientIp } = require('../utils/helpers');

/**
 * Express 鉴权中间件
 * 支持三种鉴权方式：
 * 1. JWT Bearer token（本地签发验证）——携带了 Bearer 但校验失败（畸形/过期/缺 sub）
 *    时挂 ok:false 的 identity，交由路由层拒绝（本中间件保持不拦截设计）；
 *    未携带 Bearer 才走 2/3 级回退（2026-09-21 拍板收紧）
 * 2. 旧版 Query Token（兼容过渡期）
 * 3. 匿名回退 — 基于 client_id/IP 生成确定性身份
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
      if (payload.sub) {
        req.identity = { ok: true, kind: 'session', subjectId: payload.sub };
        return next();
      }
    } catch (_) { /* fall through to invalid_bearer */ }
    req.identity = { ok: false, kind: 'invalid_bearer' };
    return next();
  }

  // 2. 旧版 Query Token
  const legacyToken = req.query?.token || req.body?.token || '';
  if (config.authToken && legacyToken === config.authToken) {
    const legacyId = req.body?._cid || req.body?.client_id || req.query?.client_id || 'legacy';
    req.identity = { ok: true, kind: 'legacy', subjectId: `legacy:${normalizeClientId(legacyId)}` };
    return next();
  }

  // 3. 匿名回退 — 基于 client_id 或 IP 生成确定性匿名身份
  const anonClientId = normalizeClientId(req.body?._cid || req.body?.client_id || req.query?.client_id || '');
  const anonSource = anonClientId || getClientIp(req);
  req.identity = { ok: true, kind: 'anonymous', subjectId: `anon:${hashValue(anonSource, config.ipHashSalt)}` };
  return next();
}

module.exports = authMiddleware;
