'use strict';

/**
 * Express 入口 — 整合路由、中间件、定时任务
 * 将 15 个云函数整合为一个 Express 应用
 */

const express = require('express');
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
const storyRoute = require('./routes/story');
const heroesRoute = require('./routes/heroes');
const configRoute = require('./routes/config');
const cheerRoute = require('./routes/cheer');
const askRoute = require('./routes/ask');
const checkinRoute = require('./routes/checkin');

// 定时任务
const { startScheduler } = require('./jobs/scheduler');

// ── 初始化 MongoDB 连接 ──
const { getDb } = require('./db/mongo');

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
app.use('/api/story', storyRoute);
app.use('/api/heroes', heroesRoute);
// 需鉴权接口（内容安全过滤）
app.use('/api/cheer', contentFilterMiddleware, cheerRoute);
app.use('/api/ask', contentFilterMiddleware, askRoute);
app.use('/api/checkins', checkinRoute);

// ── 健康检查 ──
app.get('/api/health', async (req, res) => {
  try {
    const db = await getDb();
    const adminDb = db.admin();
    const result = await adminDb.command({ ping: 1 });
    res.json({ status: 'ok', mongo: result.ok === 1 ? 'connected' : 'error', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', mongo: 'disconnected', error: e.message, timestamp: new Date().toISOString() });
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
    // 确保 MongoDB 连接就绪
    await getDb();
    console.log('[server] MongoDB connection established');

    // 启动定时任务
    startScheduler();

    // 启动 HTTP 服务
    app.listen(config.port, () => {
      console.log(`[server] Wuyan Cheer API listening on port ${config.port}`);
    });
  } catch (err) {
    console.error('[server] Startup failed:', err.message);
    process.exit(1);
  }
}

start();
