'use strict';

/**
 * CORS 中间件 — 移植自 runtime.js resolveAllowedOrigin
 */

const config = require('../config/env');

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || '';
  const allowedOrigin = resolveAllowedOrigin(origin);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
  res.setHeader('Vary', 'Origin');

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  next();
}

function resolveAllowedOrigin(origin) {
  if (!origin) return '';
  if (config.allowedOrigins.includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/u.test(origin) && config.allowLocalhost) return origin;
  return '';
}

module.exports = corsMiddleware;
