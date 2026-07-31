'use strict';

/**
 * auth 路由 — JWT 登录端点（替代 CloudBase signInWithPassword）
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId, hashValue, normalizeClientId, getClientIp } = require('../utils/helpers');
const { resolveIdentity } = require('../services/identity');

const router = express.Router();

router.post('/login', async (req, res) => {
  const requestId = getRequestId(req);
  const { username, password } = req.body || {};

  const user = config.appUsers.find((u) => u.username === username && u.password === password);
  if (!user) return errorResponse(res, 401, 'AUTH_FAILED', '账号或密码错误', requestId);

  const token = jwt.sign(
    { sub: user.subjectId, username: user.username },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return successResponse(res, { access_token: token, expires_in: 604800 }, requestId);
});

// GET /me — 验证当前 JWT 是否有效，返回用户信息
router.get('/me', async (req, res) => {
  const requestId = getRequestId(req);
  const identity = await resolveIdentity(req);
  if (identity.kind !== 'session') {
    return errorResponse(res, 401, 'SESSION_REQUIRED', '会话无效或已过期', requestId);
  }
  return successResponse(res, {
    username: identity.username,
    subject_id: identity.subjectId,
  }, requestId);
});

// 匿名登录 — 替代原 CloudBase signInAnonymously
// 前端可调用此端点获取匿名 JWT，也可不调用直接由 resolveIdentity 回退
router.post('/anonymous', async (req, res) => {
  const requestId = getRequestId(req);
  const clientId = normalizeClientId(req.body?._cid || req.body?.client_id || '');
  const anonSource = clientId || getClientIp(req);
  const subjectId = `anon:${hashValue(anonSource, config.ipHashSalt)}`;

  const token = jwt.sign(
    { sub: subjectId, anonymous: true },
    config.jwtSecret,
    { expiresIn: '30d' }
  );

  return successResponse(res, { access_token: token, expires_in: 2592000, anonymous: true }, requestId);
});

module.exports = router;
