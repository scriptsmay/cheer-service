'use strict';

process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '赌博';
process.env.AI_STREAM_TOTAL_TIMEOUT_MS = '240000';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const db = require('../src/db');
const identity = require('../src/services/identity');
const ai = require('../src/services/ai');
const settingsStore = require('../src/services/settings-store');
const config = require('../src/config/env');

const originals = {
  collection: db.collection,
  runTransaction: db.runTransaction,
  command: db.command,
  resolveIdentity: identity.resolveIdentity,
  generateText: ai.generateText,
  generateTextStream: ai.generateTextStream,
  getCheerSettings: settingsStore.getCheerSettings,
  getActiveEventsForDate: settingsStore.getActiveEventsForDate,
  aiStreamTotalTimeoutMs: config.aiStreamTotalTimeoutMs,
};

function makeCollection(writes = [], name = '') {
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    skip: () => query,
    get: async () => ({ data: [] }),
    count: async () => 0,
  };
  return {
    ...query,
    doc: () => ({
      get: async () => ({ data: [] }),
      set: async (doc) => { writes.push({ name, operation: 'set', doc }); },
      update: async (doc) => { writes.push({ name, operation: 'update', doc }); },
      remove: async () => { writes.push({ name, operation: 'remove' }); },
    }),
    add: async () => ({ id: 'test-id' }),
  };
}

function resetMocks() {
  config.aiStreamTotalTimeoutMs = originals.aiStreamTotalTimeoutMs;
  db.collection = async () => makeCollection();
  db.runTransaction = async (fn) => fn(() => makeCollection());
  db.command = { gte: (value) => value };
  identity.resolveIdentity = async () => ({ ok: true, kind: 'anonymous', subjectId: 'anon:test' });
  ai.generateText = async () => ({ text: '', usage: {} });
  ai.generateTextStream = async () => ({ text: '', model: null, usage: {} });
  settingsStore.getCheerSettings = async () => ({
    mode: 'emotion',
    event_context_enabled: false,
    date_context_enabled: false,
  });
  settingsStore.getActiveEventsForDate = async () => [];
}

function loadCheerRouter() {
  delete require.cache[require.resolve('../src/routes/cheer')];
  return require('../src/routes/cheer');
}

async function postStream({ body = { mood: 'daily', client_id: 'client-1234' } } = {}) {
  const cheerRouter = loadCheerRouter();
  const operations = [];
  const app = express();
  app.use(express.json());
  app.use('/api/cheer', (req, res, next) => {
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk, ...args) => {
      operations.push({ type: 'write', value: String(chunk) });
      return write(chunk, ...args);
    };
    res.end = (chunk, ...args) => {
      operations.push({ type: 'end', value: chunk == null ? '' : String(chunk) });
      return end(chunk, ...args);
    };
    return cheerRouter(req, res, next);
  });

  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = http.request({
        port: server.address().port,
        path: '/api/cheer/stream',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => resolve({ statusCode: response.statusCode, raw, operations }));
      });
      request.on('error', reject);
      request.end(payload);
    });
  } finally {
    server.close();
  }
}

async function captureConsole(fn) {
  const originalInfo = console.info;
  const originalError = console.error;
  const originalWarn = console.warn;
  const info = [];
  const errors = [];
  const warns = [];
  console.info = (...args) => info.push(args);
  console.error = (...args) => errors.push(args);
  console.warn = (...args) => warns.push(args);
  try {
    const result = await fn();
    return { result, info, errors, warns };
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

function summaryFrom(info) {
  const call = info.find(([label]) => label === '[ai-cheer-stream] request summary');
  return call && call[1];
}

afterEach(() => {
  db.collection = originals.collection;
  db.runTransaction = originals.runTransaction;
  db.command = originals.command;
  identity.resolveIdentity = originals.resolveIdentity;
  ai.generateText = originals.generateText;
  ai.generateTextStream = originals.generateTextStream;
  settingsStore.getCheerSettings = originals.getCheerSettings;
  settingsStore.getActiveEventsForDate = originals.getActiveEventsForDate;
  config.aiStreamTotalTimeoutMs = originals.aiStreamTotalTimeoutMs;
});

describe('/api/cheer/stream route', () => {
  test('传入绝对 deadline，错误事件先于 end，日志不泄露错误原文', async () => {
    let deadlineAt;
    resetMocks();
    ai.generateTextStream = async (options) => {
      deadlineAt = options.deadlineAt;
      const error = new Error('https://secret.example/v1 user=private authorization=Bearer secret upstream=raw-body');
      error.code = 'AI_STREAM_TOTAL_TIMEOUT';
      throw error;
    };
    const before = Date.now();
    const captured = await captureConsole(() => postStream());
    const after = Date.now();
    const { result, errors } = captured;

    assert.ok(deadlineAt >= before + config.aiStreamTotalTimeoutMs, JSON.stringify(captured));
    assert.ok(deadlineAt <= after + config.aiStreamTotalTimeoutMs, JSON.stringify(captured));
    assert.match(result.raw, /event: error/);
    assert.match(result.raw, /"code":"GENERATION_TIMEOUT"/);
    assert.match(result.raw, /本次生成耗时过长，请重试/);
    const errorWrite = result.operations.findIndex((entry) => entry.type === 'write' && entry.value.includes('event: error'));
    const endIndex = result.operations.findIndex((entry) => entry.type === 'end');
    assert.ok(errorWrite >= 0 && endIndex > errorWrite);
    assert.doesNotMatch(JSON.stringify(errors), /secret\.example|private|Bearer secret|raw-body/);
    assert.deepEqual(errors[0][1], { requestId: summaryFrom(captured.info).request_id, code: 'GENERATION_TIMEOUT' });
  });

  test('route-wide deadline 在 SSE 前终止挂起依赖并禁止迟到副作用', async () => {
    resetMocks();
    config.aiStreamTotalTimeoutMs = 30;
    const writes = [];
    db.collection = async (name) => makeCollection(writes, name);
    db.runTransaction = async (fn) => fn(() => makeCollection(writes));
    identity.resolveIdentity = () => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, kind: 'anonymous', subjectId: 'anon:late' }), 100);
    });
    let generated = false;
    ai.generateTextStream = async (options) => {
      generated = true;
      const text = JSON.stringify({
        lines: ['愿你赛场发挥从容坚定', '每次并肩都收获温暖', '向前奔跑迎接新篇', '状态在线信心满满', '一起为热爱全力'],
        emoji_caption: '一起加油',
      });
      options.onChunk({ type: 'content', data: text });
      return { text, model: 'late-model', usage: { total_tokens: 5 } };
    };

    const captured = await captureConsole(() => postStream());
    await sleep(120);
    const body = captured.result.raw.startsWith('{') ? JSON.parse(captured.result.raw) : {};
    const summaries = captured.info.filter(([label]) => label === '[ai-cheer-stream] request summary');

    assert.equal(captured.result.statusCode, 504);
    assert.equal(body.error, 'GENERATION_TIMEOUT');
    assert.equal(generated, false);
    assert.doesNotMatch(captured.result.raw, /event: complete/);
    assert.equal(writes.some((entry) => entry.name === 'ai_reports'), false);
    assert.equal(writes.some((entry) => entry.name === 'checkins'), false);
    assert.equal(writes.some((entry) => entry.name === 'usage_limits'), false);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0][1].phase, 'auth');
    assert.equal(summaries[0][1].termination, 'total_timeout');
  });

  test('SSE 建立后的 route deadline 仍发送 GENERATION_TIMEOUT 终态事件', async () => {
    resetMocks();
    config.aiStreamTotalTimeoutMs = 30;
    settingsStore.getCheerSettings = () => new Promise((resolve) => {
      setTimeout(() => resolve({ mode: 'emotion', event_context_enabled: false, date_context_enabled: false }), 100);
    });

    const captured = await captureConsole(() => postStream());
    await sleep(120);
    const summaries = captured.info.filter(([label]) => label === '[ai-cheer-stream] request summary');

    assert.equal(captured.result.statusCode, 200);
    assert.match(captured.result.raw, /event: error/);
    assert.match(captured.result.raw, /"code":"GENERATION_TIMEOUT"/);
    assert.doesNotMatch(captured.result.raw, /event: complete/);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0][1].phase, 'preparation');
    assert.equal(summaries[0][1].termination, 'total_timeout');
  });

  test('空闲超时保持内部错误码并返回专用提示', async () => {
    resetMocks();
    ai.generateTextStream = async () => {
      const error = new Error('upstream secret');
      error.code = 'AI_STREAM_IDLE_TIMEOUT';
      throw error;
    };

    const captured = await captureConsole(() => postStream());

    assert.match(captured.result.raw, /"code":"AI_STREAM_IDLE_TIMEOUT"/);
    assert.match(captured.result.raw, /本次响应长时间未更新，请重试/);
  });

  test('成功生成校验失败后重试再超时，累计 usage 并取最近实际模型', async () => {
    const deadlines = [];
    resetMocks();
    ai.generateTextStream = async (options) => {
      deadlines.push(options.deadlineAt);
      if (deadlines.length === 1) {
        options.onChunk({ type: 'content', data: '短' });
        return {
          text: '短',
          model: 'model-one',
          usage: { total_tokens: 10, prompt_tokens: 4, completion_tokens: 6 },
        };
      }
      options.onChunk({ type: 'content', data: 'x' });
      const error = new Error('timeout');
      error.code = 'AI_STREAM_TOTAL_TIMEOUT';
      error.model = 'model-two';
      error.usage = { total_tokens: 5, completion_tokens: 3 };
      throw error;
    };

    const captured = await captureConsole(() => postStream());
    const summary = summaryFrom(captured.info);

    assert.equal(deadlines.length, 2, JSON.stringify(captured));
    assert.equal(deadlines[0], deadlines[1]);
    assert.match(captured.result.raw, /event: retry/);
    assert.match(captured.result.raw, /"code":"GENERATION_TIMEOUT"/);
    assert.equal(summary.termination, 'total_timeout');
    assert.equal(summary.phase, 'generation');
    assert.equal(summary.retry_count, 1);
    assert.equal(summary.model, 'model-two');
    assert.deepEqual(summary.usage, { total_tokens: 15, prompt_tokens: 4, completion_tokens: 9 });
  });

  test('校验失败记录 reason 并在重试请求中附带失败指令', async () => {
    resetMocks();
    const messageSnapshots = [];
    ai.generateTextStream = async (options) => {
      messageSnapshots.push(options.messages.map((m) => ({ role: m.role, content: m.content })));
      if (messageSnapshots.length === 1) {
        options.onChunk({ type: 'content', data: '短' });
        return { text: '短', model: 'model-one', usage: { total_tokens: 10 } };
      }
      const text = JSON.stringify({
        lines: [
          '赛场灯光亮起时请稳住呼吸节奏',
          '训练服上的汗渍都算数请继续',
          '场边有人一直记得你的初心',
          '把每一次团战都当成决赛来打',
          '无论比分如何我们都站在你身后',
        ],
        emoji_caption: '一起加油',
      });
      options.onChunk({ type: 'content', data: text });
      return { text, model: 'model-two', usage: { total_tokens: 20 } };
    };

    const captured = await captureConsole(() => postStream());
    const summary = summaryFrom(captured.info);

    assert.equal(messageSnapshots.length, 2, JSON.stringify(captured));
    assert.equal(messageSnapshots[0].length, 2);
    assert.equal(messageSnapshots[1].length, 3);
    assert.match(messageSnapshots[1][2].content, /重新生成|字数|条数|不符合/);
    const rejected = (captured.warns || [])
      .filter(([label]) => label === '[ai-cheer] output rejected');
    assert.equal(rejected.length, 1, JSON.stringify(captured));
    assert.equal(rejected[0][1].reason, 'line_count');
    assert.equal(rejected[0][1].attempt, 1);
    assert.equal(summary.termination, 'complete');
    assert.equal(summary.retry_count, 1);
    assert.equal(summary.validation_failure, 'line_count');
  });

  test('所有 SSE 建立前终止路径都记录一次摘要', async () => {
    const cases = [
      {
        name: 'auth rejected',
        configure: () => { identity.resolveIdentity = async () => ({ ok: false }); },
        body: { mood: 'daily', client_id: 'client-1234' },
        phase: 'auth',
        termination: 'unauthorized',
      },
      {
        name: 'invalid argument',
        configure: () => {},
        body: { mood: 'bad', client_id: 'client-1234' },
        phase: 'validation',
        termination: 'invalid_argument',
      },
      {
        name: 'content blocked',
        configure: () => {},
        body: { mood: 'daily', text: '赌博', client_id: 'client-1234' },
        phase: 'validation',
        termination: 'content_blocked',
      },
      {
        name: 'identity throws',
        configure: () => { identity.resolveIdentity = async () => { throw new Error('identity secret'); }; },
        body: { mood: 'daily', client_id: 'client-1234' },
        phase: 'auth',
        termination: 'error',
      },
    ];

    for (const testCase of cases) {
      resetMocks();
      testCase.configure();
      const captured = await captureConsole(() => postStream({ body: testCase.body }));
      const summaries = captured.info.filter(([label]) => label === '[ai-cheer-stream] request summary');
      assert.equal(summaries.length, 1, testCase.name);
      assert.equal(summaries[0][1].phase, testCase.phase, testCase.name);
      assert.equal(summaries[0][1].termination, testCase.termination, testCase.name);
      assert.doesNotMatch(JSON.stringify(captured.errors), /identity secret/, testCase.name);
    }
  });
});
