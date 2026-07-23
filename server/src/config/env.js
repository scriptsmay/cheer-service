'use strict';

/**
 * 环境变量集中管理
 * 所有配置项从这里统一导出，避免散落在各模块直接读 process.env
 */

const config = {
  // MongoDB
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/wuyan',
  mongoDbName: 'wuyan',

  // AI (OpenAI 兼容)
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1',
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'deepseek-chat',

  // JWT 鉴权
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  jwtExpiresIn: '7d',

  // 旧版 Token 鉴权（兼容）
  authToken: process.env.AUTH_TOKEN || '',

  // 用户表（用于 JWT 登录）
  appUsers: JSON.parse(process.env.APP_USERS || '[]'),

  // CORS
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  allowLocalhost: process.env.ALLOW_LOCALHOST === 'true',

  // 内容安全
  blockedTerms: String(process.env.BLOCKED_TERMS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // 限流
  ipHashSalt: process.env.IP_HASH_SALT || 'default_salt',

  // 数据同步源
  dataBaseUrl: process.env.DATA_BASE_URL || 'https://cal.kplwuyan.site',

  // 服务端口
  port: parseInt(process.env.PORT || '3000', 10),
};

module.exports = config;
