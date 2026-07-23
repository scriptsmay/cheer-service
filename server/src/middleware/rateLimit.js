'use strict';

/**
 * 限流中间件 — 移植自 usage_limits 逻辑
 * 为 ai-cheer / ask / checkin 提供请求级别的限流检查
 *
 * 注意：实际的限流计数在路由处理函数内通过 DB 事务完成（与原逻辑一致）
 * 此中间件仅做 IP 级快速拦截，防止明显滥用
 */

const { hashValue } = require('../utils/helpers');
const config = require('../config/env');

// IP 级快速限流缓存（内存，每分钟清理）
const ipCache = new Map();
const CACHE_TTL = 60 * 1000; // 1 分钟

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const minute = new Date().toISOString().slice(0, 16);
  const key = `ip:${hashValue(ip, config.ipHashSalt)}:${minute}`;

  const cached = ipCache.get(key);
  if (cached && cached.count >= 200) {
    // IP 级别每分钟 200 次硬上限（比业务限流更宽松，仅防极端滥用）
    return res.status(429).json({
      code: 429,
      message: '请求过于频繁，请稍后重试',
      retry_after: 60,
    });
  }

  if (cached) {
    cached.count++;
  } else {
    ipCache.set(key, { count: 1, ts: Date.now() });
  }

  // 定期清理过期缓存
  if (ipCache.size > 10000) {
    const now = Date.now();
    for (const [k, v] of ipCache) {
      if (now - v.ts > CACHE_TTL) ipCache.delete(k);
    }
  }

  next();
}

module.exports = rateLimitMiddleware;
