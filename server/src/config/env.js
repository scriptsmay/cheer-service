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
  aiTimeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '180000', 10),
  // 流式生成空闲超时：每收到一次数据就重置，只约束「无数据间隔」，
  // 不限制总时长（思考型模型推理可远超 3 分钟，靠 15s 心跳保活 SSE 链路）
  aiStreamIdleTimeoutMs: parseInt(process.env.AI_STREAM_IDLE_TIMEOUT_MS || '90000', 10),

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

  // kpl-data-daily 本地数据目录（local 数据源模式的挂载路径）
  kplDataDir: process.env.KPL_DATA_DIR || '/app/kpl-data-daily',

  // KPL 采集产物的数据源：local（宿主机挂载目录）| github（GitHub raw）
  // 业务分离后采集在宿主机 timer，产物已 git 备份回 kpl_data_daily 仓库，
  // github 模式可摆脱宿主机挂载依赖（免费云迁移 Phase 1），默认 local 可一键回退。
  kplSource: (process.env.KPL_SOURCE || 'github').toLowerCase(),
  kplGithubRawBase: process.env.KPL_GITHUB_RAW_BASE
    || 'https://raw.githubusercontent.com/scriptsmay/kpl_data_daily/main',
  kplFetchTimeoutMs: parseInt(process.env.KPL_FETCH_TIMEOUT_MS || '15000', 10),

  // KPL 数据链路总开关（CRAWL_ENABLED=false 时暂停 kpl 同步与实时赛程任务）
  // 用于维护期整体暂停 KPL 数据链路
  // 受影响: kpl_crawl(文件→MongoDB 同步)、syncScheduleLive(实时赛程，调 KPL 官方 API)
  crawlEnabled: process.env.CRAWL_ENABLED !== 'false',


  // AI 文案数据模式：season | career | emotion（DB 优先，此为兜底默认）
  cheerDataMode: (process.env.CHEER_DATA_MODE || 'season').toLowerCase(),

  // weekly_story 定时任务默认开关（DB 优先，此为兜底默认）
  weeklyStoryEnabled: process.env.WEEKLY_STORY_ENABLED !== 'false',

  // 服务端口
  port: parseInt(process.env.PORT || '3000', 10),
};

module.exports = config;
