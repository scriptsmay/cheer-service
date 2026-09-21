'use strict';

/**
 * 回归测试：GET /api/admin/sync/status 的引用完整性。
 * Phase 3 移除调度配置时删掉了 getScheduleList 的 import 却漏删响应字段，
 * 线上该接口每次请求都 500（ReferenceError）。本测试刻意不打桩 schedules 相关
 * 模块、不连真实 DB：只要处理链路过引用解析、停在 DB 查询边界即通过；
 * 若再现任何 "X is not defined" 说明又留下了悬空引用。
 */

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27999/never-connects';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

const config = require('../src/config/env');
const authMiddleware = require('../src/middleware/auth');
const adminRouter = require('../src/routes/admin');

test('GET /api/admin/sync/status 无悬空引用（应停在 DB 边界而非 ReferenceError）', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', authMiddleware, adminRouter);

  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const token = jwt.sign({ sub: 'tester:default' }, config.jwtSecret);
    const body = await new Promise((resolve, reject) => {
      http.get(
        { port: server.address().port, path: '/api/admin/sync/status', headers: { Authorization: `Bearer ${token}` } },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve(raw));
        }
      ).on('error', reject);
    });
    assert.doesNotMatch(body, /is not defined/, `sync/status 存在悬空引用: ${body}`);
  } finally {
    server.close();
  }
});
