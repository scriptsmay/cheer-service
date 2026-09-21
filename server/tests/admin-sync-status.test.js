'use strict';

/**
 * 回归测试：GET /api/admin/sync/status 的引用与响应形状。
 *
 * Phase 3 移除调度配置时删掉了 getScheduleList 的 import 却漏删响应字段，
 * 线上该接口每次请求 500（ReferenceError）。此类悬空引用只在**执行到 res.json
 * 那一行**才暴露，故必须把 DB 门面打桩成返回空数据，让处理链路真正跑完——
 * 只连不上库的「错误路径」测试是假阳性（DB 异常先抛出，永远碰不到引用行）。
 */

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

const config = require('../src/config/env');
const db = require('../src/db');

// 链式查询门面桩：任意 where/orderBy/limit 后 get() 返回空集
function fakeCollection() {
  const chain = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    get: async () => ({ data: [] }),
  };
  return () => chain;
}
db.collection = fakeCollection();

// admin 路由在 require 时解构 collection，必须先打桩再加载
const authMiddleware = require('../src/middleware/auth');
const adminRouter = require('../src/routes/admin');

async function getSyncStatus() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', authMiddleware, adminRouter);

  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const token = jwt.sign({ sub: 'tester:default' }, config.jwtSecret);
    return await new Promise((resolve, reject) => {
      http.get(
        { port: server.address().port, path: '/api/admin/sync/status', headers: { Authorization: `Bearer ${token}` } },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: raw }));
        }
      ).on('error', reject);
    });
  } finally {
    server.close();
  }
}

test('sync/status 处理链路跑到 res.json（无悬空引用）', async () => {
  const { statusCode, body } = await getSyncStatus();
  assert.doesNotMatch(body, /is not defined/, `sync/status 存在悬空引用: ${body}`);
  assert.equal(statusCode, 200, `预期 200，实际 ${statusCode}: ${body}`);
});

test('sync/status 不再返回已废弃的 schedules 字段', async () => {
  const { body } = await getSyncStatus();
  const d = JSON.parse(body);
  assert.equal('schedules' in d, false, '定时任务清单已从调度配置移除，接口不应再返回该字段');
  assert.deepEqual(Object.keys(d).sort(), ['last_daily_sync', 'last_schedule_sync', 'ok', 'player_overview']);
});
