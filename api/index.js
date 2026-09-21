/**
 * Vercel Function 入口 — cheer-service Express 应用
 *
 * Vercel 将此文件作为 Serverless Function 部署，
 * 导出 Express app 作为 handler，所有路由由 app.js 统一处理。
 */

const { app } = require('../server/src/app');

module.exports = app;
