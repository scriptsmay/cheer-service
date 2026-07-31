'use strict';

/**
 * 身份解析服务 — 替代 TCB CloudBase Auth
 *
 * 三级鉴权链：
 * 1. JWT Bearer token（本地签发验证）
 * 2. 旧版 Query Token（兼容过渡期）
 */

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { hashValue, normalizeClientId } = require('../utils/helpers');

/**
 * 从 Express 请求中解析用户身份
 * @param {Object} req - Express request
 * @returns {Promise<{ok: boolean, kind?: string, subjectId?: string}>}
 */
async function resolveIdentity(req) {
  // 1. JWT Bearer token
  const bearer = getBearerToken(req);
  if (bearer) {
    try {
      const payload = jwt.verify(bearer, config.jwtSecret);
      if (payload.sub) {
        return { ok: true, kind: 'session', subjectId: payload.sub, username: payload.username || '' };
      }
    } catch (_) {
      /* invalid token, fall through */
    }
  }

  // 2. 旧版 Query Token（保留兼容）
  const legacyToken = req.query?.token || req.body?.token || '';
  if (config.authToken && legacyToken === config.authToken) {
    const legacyId = req.body?._cid || req.body?.client_id || req.query?.client_id || 'legacy';
    return { ok: true, kind: 'legacy', subjectId: `legacy:${normalizeClientId(legacyId)}` };
  }

  return { ok: false };
}

function getBearerToken(req) {
  const auth = req.headers?.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/iu);
  return match ? match[1].trim() : '';
}

module.exports = { resolveIdentity, getBearerToken };
