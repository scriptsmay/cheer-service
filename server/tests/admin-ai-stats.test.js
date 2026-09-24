'use strict';

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

const now = Date.now();
let records = [];
let queryFilter = null;
let collectionName = null;

function fakeCollection(name) {
  collectionName = name;
  const chain = {
    where(filter) {
      queryFilter = filter;
      return chain;
    },
    get: async () => ({ data: records }),
  };
  return chain;
}

db.collection = fakeCollection;
const authMiddleware = require('../src/middleware/auth');
const adminRouter = require('../src/routes/admin');

async function request(path, token) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', authMiddleware, adminRouter);
  const server = http.createServer(app).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    return await new Promise((resolve, reject) => {
      http.get({ port: server.address().port, path, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }).on('error', reject);
    });
  } finally {
    server.close();
  }
}

test('ai/stats aggregates attempts by model and requires auth', async () => {
  records = [
    { model: 'm1', status: 'complete', elapsed_ms: 100, retry_count: 0, validation_failure: null, usage: { total_tokens: 10 }, created_at: new Date(now - 1000).toISOString() },
    { model: 'm1', status: 'error', elapsed_ms: 200, retry_count: 2, validation_failure: 'too_short', usage: { total_tokens: 4 }, created_at: new Date(now - 2000).toISOString() },
    { model: 'm2', status: 'complete', elapsed_ms: 300, retry_count: 1, validation_failure: null, usage: { total_tokens: 8 }, created_at: new Date(now - 3000).toISOString() },
  ];
  const unauthorized = await request('/api/admin/ai/stats?window=24h');
  assert.equal(unauthorized.statusCode, 401);

  const token = jwt.sign({ sub: 'tester:default' }, config.jwtSecret);
  const response = await request('/api/admin/ai/stats?window=24h', token);
  const data = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(collectionName, 'ai_generation_attempts');
  assert.equal(queryFilter.created_at.$gte < new Date(now - 24 * 60 * 60 * 1000).toISOString(), false);
  assert.deepEqual(Object.keys(data), ['window', 'generated_at', 'models']);
  assert.equal(data.window, '24h');
  assert.deepEqual(data.models, [
    { model: 'm2', samples: 1, complete: 1, success_rate: 1, p50_ms: 300, p95_ms: 300, retries: 1, validation_failures: 0, validation_reasons: {}, tokens: 8 },
    { model: 'm1', samples: 2, complete: 1, success_rate: 0.5, p50_ms: 100, p95_ms: 200, retries: 2, validation_failures: 1, validation_reasons: { too_short: 1 }, tokens: 14 },
  ]);
  assert.doesNotMatch(response.body, /request_id|output|api_key|base_url/i);
});

test('ai/stats supports 7d and 30d and empty datasets', async () => {
  records = [];
  const token = jwt.sign({ sub: 'tester:default' }, config.jwtSecret);
  for (const window of ['7d', '30d']) {
    const response = await request(`/api/admin/ai/stats?window=${window}`, token);
    const data = JSON.parse(response.body);
    assert.equal(response.statusCode, 200);
    assert.equal(data.window, window);
    assert.deepEqual(data.models, []);
  }
});

test('ai/stats rejects invalid windows', async () => {
  const token = jwt.sign({ sub: 'tester:default' }, config.jwtSecret);
  const response = await request('/api/admin/ai/stats?window=1y', token);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { code: 'INVALID_ARGUMENT', message: 'window 必须是 24h、7d 或 30d' });
});
