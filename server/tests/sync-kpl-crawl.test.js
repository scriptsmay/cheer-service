'use strict';

/**
 * 回归测试：syncKplCrawl 的变更检测状态戳必须走数据库（app_config/kpl_sync_state）。
 *
 * 旧实现把状态戳写在容器可写卷 /app/data/.kpl_last_sync —— Vercel serverless 除 /tmp
 * 外文件系统不可写，线上手动同步每次都在最后一步 ENOENT：数据入库成功但状态永不落盘，
 * 于是每轮都判定「有变更」全量重跑，且 /api/cron/daily 恒报失败。文件系统假设只能靠
 * 真实执行链路拦住，故此处断言状态读写落在 DB 且全程零文件写入。
 */

process.env.NODE_ENV = 'production';
process.env.DB_DRIVER = 'postgres';
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

const config = require('../src/config/env');
const db = require('../src/db');
const kplSource = require('../src/lib/kpl-source');
const syncDataJob = require('../src/jobs/syncData');
const syncScheduleJob = require('../src/jobs/syncSchedule');

const STATE_KEY = 'app_config/kpl_sync_state';

// 打桩须在 require 被测模块之前完成：syncKplCrawl / admin 路由在加载期就解构依赖
const stub = {
  docs: new Map(),
  reads: [],
  writes: [],
  failWrites: false,
  prevState: 'not-called',
  dataRuns: 0,
};

db.collection = async (name) => ({
  doc(id) {
    const key = `${name}/${id}`;
    return {
      async get() {
        stub.reads.push(key);
        const doc = stub.docs.get(key);
        return { data: doc ? [doc] : [] };
      },
      async set(data) {
        if (stub.failWrites) throw new Error('EROFS: read-only file system');
        stub.writes.push({ key, data });
        stub.docs.set(key, data);
      },
    };
  },
});

kplSource.getMode = () => 'github';
kplSource.readKplJson = async () => ({ current: 'TESTSEASON' });
kplSource.checkChanged = async (season, prevState) => {
  stub.prevState = prevState;
  if (stub.noChanges) return { changed: false, state: { timestampMs: 0, etags: {} } };
  return { changed: true, state: { timestampMs: 1700000000000, etags: { 'a.json': 'W/"1"' } } };
};
syncDataJob.syncData = async () => {
  stub.dataRuns += 1;
  if (stub.onData) await stub.onData();
};
syncScheduleJob.syncSchedule = async () => {};

const syncJob = require('../src/jobs/syncKplCrawl');

function resetStub(initialDocs = []) {
  stub.docs = new Map(initialDocs);
  stub.reads = [];
  stub.writes = [];
  stub.failWrites = false;
  stub.prevState = 'not-called';
  stub.dataRuns = 0;
  stub.onData = null;
  stub.noChanges = false;
}

/** 监听整个同步链路是否偷偷碰文件系统 */
async function runWithoutFsWrites() {
  const writeFile = fs.writeFile;
  const readFile = fs.readFile;
  let touched = 0;
  fs.writeFile = async (...args) => { touched += 1; return writeFile(...args); };
  fs.readFile = async (...args) => { touched += 1; return readFile(...args); };
  try {
    const result = await syncJob.syncKplCrawl();
    return { result, touched };
  } finally {
    fs.writeFile = writeFile;
    fs.readFile = readFile;
  }
}

test('状态戳读写走 DB，不碰文件系统', async () => {
  const stored = { state: { timestampMs: 123, etags: { old: 'W/0' } }, updated_at: 'x' };
  resetStub([[STATE_KEY, stored]]);

  const { result, touched } = await runWithoutFsWrites();

  assert.deepEqual(stub.prevState, stored.state, '应把库里存的状态传给变更检测');
  assert.equal(touched, 0, '同步状态不得再读写容器卷文件（serverless 上必失败）');
  assert.equal(result.synced, true, `全链路成功应标记 synced: ${JSON.stringify(result)}`);
  assert.deepEqual(stub.writes.map((w) => w.key), [STATE_KEY]);
  assert.deepEqual(stub.writes[0].data.state, { timestampMs: 1700000000000, etags: { 'a.json': 'W/"1"' } });
});

test('状态戳写入失败计入 errors 且不标记 synced', async () => {
  resetStub();
  stub.failWrites = true;

  const result = await syncJob.syncKplCrawl();

  assert.equal(result.hasChanges, true);
  assert.equal(result.synced, false);
  assert.deepEqual(result.errors, ['syncState: EROFS: read-only file system']);
  assert.equal(stub.writes.length, 0);
});

test('无变更时不入库也不写状态', async () => {
  resetStub();
  stub.noChanges = true;

  const result = await syncJob.syncKplCrawl();

  assert.equal(result.hasChanges, false);
  assert.equal(result.synced, false);
  assert.equal(stub.dataRuns, 0);
  assert.deepEqual(stub.writes, []);
});

test('同步进行中重复触发返回 in-flight，结束后复位', async () => {
  resetStub();
  let release;
  const gate = new Promise((r) => { release = r; });
  stub.onData = () => gate;

  const first = syncJob.syncKplCrawl();
  assert.equal(syncJob.isSyncRunning(), true);
  const second = await syncJob.syncKplCrawl();
  release();

  assert.equal(second.skipped, 'in-flight');
  assert.equal((await first).synced, true);
  assert.equal(syncJob.isSyncRunning(), false);
});

test('POST /sync/crawl 在同步进行中回 409', async () => {
  const realSync = syncJob.syncKplCrawl;
  let started = false;
  syncJob.syncKplCrawl = async () => { started = true; return { hasChanges: false, synced: false }; };
  syncJob.isSyncRunning = () => true;

  // admin 路由在 require 时解构 syncKplCrawl/isSyncRunning，故打完桩再加载
  const adminRouter = require('../src/routes/admin');
  const authMiddleware = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', authMiddleware, adminRouter);
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));

  try {
    const token = jwt.sign({ sub: 'tester:default' }, config.jwtSecret);
    const { statusCode, body } = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          port: server.address().port,
          path: '/api/admin/sync/crawl',
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: raw }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(statusCode, 409, `同步进行中应回 409: ${body}`);
    assert.equal(JSON.parse(body).ok, false);
    assert.equal(started, false, '409 分支不得再启动一轮同步');
  } finally {
    server.close();
    syncJob.syncKplCrawl = realSync;
  }
});
