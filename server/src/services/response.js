'use strict';

/**
 * 响应封装服务 — 从 runtime.js 移植
 * 将 TCB 云函数的 statusCode+headers+body 响应格式转换为 Express res.json() 形式
 */

const config = require('../config/env');

function resolveAllowedOrigin(origin) {
  if (!origin) return '';
  if (config.allowedOrigins.includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/u.test(origin) && config.allowLocalhost) return origin;
  return '';
}

/**
 * Express 成功响应
 */
function successResponse(res, payload, requestId) {
  const origin = res.req?.headers?.origin || '';
  const allowedOrigin = resolveAllowedOrigin(origin);
  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...payload, code: 200, message: 'ok', data: payload });
}

/**
 * Express 错误响应
 */
function errorResponse(res, status, code, message, requestId, retryAfter) {
  const origin = res.req?.headers?.origin || '';
  const allowedOrigin = resolveAllowedOrigin(origin);
  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));

  res.status(status).json({
    code,
    message,
    request_id: requestId,
    ...(retryAfter ? { retry_after: retryAfter } : {}),
  });
}

module.exports = { successResponse, errorResponse, resolveAllowedOrigin };
