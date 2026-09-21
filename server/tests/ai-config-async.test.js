'use strict';

/**
 * 回归测试：ai-config 的 async 契约（v1.4.0 Phase 3 把 loadConfig/getEffectiveConfig
 * 改成 async 后，调用点漏 await 会让 baseUrl/apiKey 静默变 undefined——
 * admin 接口显示「未设置」、AI 生成请求打到 `undefined/chat/completions`）。
 * ai-stream / ai-models 两套测试都把 getEffectiveConfig 打桩成同步对象，
 * 掩盖了这个契约，故此处刻意使用**真实模块**驱动到网络边界。
 */

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ADMIN_USERS = '[{"username":"tester","password":"pw","subjectId":"tester:default"}]';
process.env.AI_BASE_URL = 'https://ai.test/v1';
process.env.AI_API_KEY = 'sk-test-effective-key';
process.env.AI_MODEL = 'test-model';
delete process.env.DB_DRIVER;
delete process.env.POSTGRES_URI;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const config = require('../src/config/env');
const aiConfig = require('../src/services/ai-config');
const { generateText } = require('../src/services/ai');

const realFetch = globalThis.fetch;

function withMockFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(url, opts);
}

test('getEffectiveConfig 是异步的（契约固定，防再次同步化打桩掩盖）', async () => {
  const ret = aiConfig.getEffectiveConfig();
  assert.ok(ret && typeof ret.then === 'function', 'getEffectiveConfig() 必须返回 Promise');
  const cfg = await ret;
  assert.equal(cfg.baseUrl, 'https://ai.test/v1');
  assert.equal(cfg.apiKey, 'sk-test-effective-key');
  assert.equal(cfg._source, 'env');
});

test('generateText 用真实配置发起请求（URL 与 Authorization 不得为 undefined）', async () => {
  let seen = null;
  withMockFetch(async (url, opts) => {
    seen = { url, auth: opts.headers.Authorization };
    throw new Error('stop-before-network');
  });
  await assert.rejects(() => generateText({ messages: [{ role: 'user', content: 'hi' }] }));
  globalThis.fetch = realFetch;

  assert.equal(seen.url, 'https://ai.test/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer sk-test-effective-key');
});

test('GET /api/admin/ai/config 报告 key 已配置', async () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const authMiddleware = require('../src/middleware/auth');
  const adminRouter = require('../src/routes/admin');

  const app = express();
  app.use(express.json());
  app.use('/api/admin', authMiddleware, adminRouter);

  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const token = jwt.sign({ sub: 'tester:default' }, config.jwtSecret);
  const body = await new Promise((resolve, reject) => {
    http.get(
      { port: server.address().port, path: '/api/admin/ai/config', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve(JSON.parse(raw)));
      }
    ).on('error', reject);
  });
  server.close();

  assert.equal(body.api_key_configured, true, `接口未报告 key 已配置：${JSON.stringify(body)}`);
  assert.equal(body.base_url, 'https://ai.test/v1');
  assert.equal(body.model, 'test-model');
});
