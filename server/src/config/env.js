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

  // 数据同步源（HTTP pull 模式，已禁用）
  // 原默认值 https://cal.kplwuyan.site 域名不存在且从未生效，
  // 实际数据通过 GH Actions POST /api/admin/sync/* 推送。
  // 迁移后将改为容器内本地文件读取，见 docs/kpl-crawl-migration.md
  dataBaseUrl: process.env.DATA_BASE_URL || '',

  // kpl-data-daily 本地数据目录（容器内挂载路径）
  kplDataDir: process.env.KPL_DATA_DIR || '/app/kpl-data-daily',

  // 第三方采集开关（CRAWL_ENABLED=false 时暂停所有调用第三方 API 的采集任务）
  // 用于第三方接口不可用时暂停采集，避免无效请求和错误日志
  // 受影响: syncKplCrawl(Python 采集)、syncScheduleLive(实时赛程)
  // 不受影响: syncData/syncSchedule(读本地文件，不调第三方)
  crawlEnabled: process.env.CRAWL_ENABLED !== 'false',

  // 数据同步 API Key（push 模式，kpl-data-daily GitHub Actions 推送用）
  syncApiKey: process.env.SYNC_API_KEY || '',

  // 服务端口
  port: parseInt(process.env.PORT || '3000', 10),
};

module.exports = config;
