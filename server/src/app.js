'use strict';

/**
 * Express 入口 — 整合路由、中间件、定时任务
 * 将 15 个云函数整合为一个 Express 应用
 */

const express = require('express');
const path = require('path');
const config = require('./config/env');
const corsMiddleware = require('./middleware/cors');
const rateLimitMiddleware = require('./middleware/rateLimit');
const authMiddleware = require('./middleware/auth');
const { contentFilterMiddleware } = require('./middleware/contentFilter');

// 路由
const authRoute = require('./routes/auth');
const overviewRoute = require('./routes/overview');
const liveRoute = require('./routes/live');
const scheduleRoute = require('./routes/schedule');
const heroesRoute = require('./routes/heroes');
const configRoute = require('./routes/config');
const cheerRoute = require('./routes/cheer');
const askRoute = require('./routes/ask');
const checkinRoute = require('./routes/checkin');
const adminRoute = require('./routes/admin');
const cronRoute = require('./routes/cron');

// 定时任务
const { startScheduler } = require('./jobs/scheduler');

// ── 初始化 MongoDB 连接 ──
const db = require('./db');

const app = express();

// ── 全局中间件 ──
app.use(express.json({ limit: '1mb' }));
app.use(corsMiddleware);
app.use(rateLimitMiddleware);
app.use(authMiddleware); // 将 identity 挂到 req 上（不拦截，让路由自行判断）

// ── 路由注册 ──
// 公开接口（无需有效 identity）
app.use('/api/auth', authRoute);
app.use('/api/config', configRoute);
app.use('/api/overview', overviewRoute);
app.use('/api/live', liveRoute);
app.use('/api/schedule', scheduleRoute);
app.use('/api/heroes', heroesRoute);
// 需鉴权接口（内容安全过滤）
app.use('/api/cheer', contentFilterMiddleware, cheerRoute);
app.use('/api/ask', contentFilterMiddleware, askRoute);
app.use('/api/checkins', checkinRoute);
// 运维接口
app.use('/api/admin', adminRoute);
app.use('/api/cron', cronRoute);

// ── 静态资源（管理页面前端：自包含 admin.html；/admin-static 兼容保留）──
// 与后端 API 分离，便于独立维护；HTML 由 GET /api/admin 以 sendFile 返回
app.use('/admin-static', express.static(path.join(__dirname, '..', 'public')));

// ── 健康检查 ──
const pkgInfo = require('../../package.json');
app.get('/api/health', async (req, res) => {
  try {
    const ok = await db.ping();
    res.json({
      status: 'ok',
      version: pkgInfo.version,
      db: ok ? 'connected' : 'error',
      driver: config.dbDriver,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(503).json({
      status: 'error',
      version: pkgInfo.version,
      db: 'disconnected',
      driver: config.dbDriver,
      error: e.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在' });
});

// ── 错误处理 ──
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err.message, err.stack);
  res.status(500).json({ code: 500, message: '服务内部错误' });
});

// ── 启动服务 ──
async function start() {
  try {
    // 确保数据库连接就绪（后端由 DB_DRIVER 决定）
    await db.ping();
    console.log(`[server] Database connection established (driver: ${config.dbDriver})`);

    // 启动定时任务（读取 app_config 运行时配置，故为异步）；
    // Vercel serverless 下关闭（SCHEDULER_ENABLED=false），任务走 /api/cron/daily
    if (config.schedulerEnabled) {
      await startScheduler();
    } else {
      console.log('[server] scheduler disabled (SCHEDULER_ENABLED=false)');
    }

    // 启动 HTTP 服务
    app.listen(config.port, () => {
      console.log(`[server] Wuyan Cheer API listening on port ${config.port}`);
    });
  } catch (err) {
    console.error('[server] Startup failed:', err.message);
    process.exit(1);
  }
}

// 常驻运行（Docker/本地）才自启动；被 Vercel Function 引入时只导出 app 由平台调度
if (require.main === module) {
  start();
}

module.exports = { app, start };
