'use strict';

/**
 * auth 路由 — JWT 登录端点（替代 CloudBase signInWithPassword）
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId } = require('../utils/helpers');
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

module.exports = router;
