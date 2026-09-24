'use strict';

/**
 * generateTextStream 单元测试
 * - SSE 增量解析（reasoning_content / content delta）
 *
 * 通过 require.cache 替换 ai-config.getEffectiveConfig 打桩上游配置；
 * mock fetch 必须尊重 AbortSignal（abort 时 error 掉响应流）——与真实 undici 行为一致，
 * 否则空闲超时中断在 mock 里永远不会发生。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const aiConfigPath = require.resolve('../src/services/ai-config');
const aiConfig = require(aiConfigPath);
let effectiveConfig = { baseUrl: 'https://mock.local/v1', apiKey: 'test-key', model: 'test-model' };
aiConfig.getEffectiveConfig = () => ({ ...effectiveConfig });

// 每个用例可指定不同空闲阈值（env.js 在 require 时读取）
function loadGenerateTextStream(idleMs, totalMs = 240000) {
  process.env.AI_STREAM_IDLE_TIMEOUT_MS = String(idleMs);
  process.env.AI_STREAM_TOTAL_TIMEOUT_MS = String(totalMs);
  delete require.cache[require.resolve('../src/config/env.js')];
  delete require.cache[require.resolve('../src/services/ai.js')];
  const ai = require('../src/services/ai.js');
  return ai.generateTextStream;
}

const encoder = new TextEncoder();
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestBody = null;

/**
 * 构造 mock fetch：返回 SSE Response。
 * - lines 逐条下发，每条间隔 intervalMs
 * - holdOpen=true 时发完不关闭（模拟上游挂起，考验空闲超时）
 * - 监听 opts.signal：abort 时以 signal.reason error 掉流（等价真实 fetch 行为）
 */
function mockSseFetch(lines, { intervalMs = 0, holdOpen = false } = {}) {
  let streamController = null;
  let stopped = false;
  lastRequestBody = null;

  const stream = new ReadableStream({
    start(c) {
      streamController = c;
    },
  });

  (async () => {
    for (const line of lines) {
      if (stopped) return;
      if (intervalMs > 0) await sleep(intervalMs);
      if (stopped) return;
      streamController.enqueue(encoder.encode(line));
    }
    if (holdOpen || stopped) return;
    streamController.close();
  })();

  return async (_url, opts = {}) => {
    lastRequestBody = opts.body;
    opts.signal?.addEventListener('abort', () => {
      stopped = true;
      streamController.error(opts.signal.reason ?? new Error('aborted'));
    });
    return new Response(stream, { status: 200 });
  };
}

function makeChunks() {
  return [
    sse({ choices: [{ delta: { reasoning_content: '思考A' } }] }),
    sse({ choices: [{ delta: { reasoning_content: '思考B' } }] }),
    sse({ choices: [{ delta: { content: '第一行\n' } }] }),
    sse({ choices: [{ delta: { content: '第二行' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 42 } }),
    'data: [DONE]\n\n',
  ];
}

describe('generateTextStream', () => {
  test('增量解析：reasoning/content 分别回调 delta 与累计值，返回完整文本与 usage', async () => {
    const generateTextStream = loadGenerateTextStream(1000);
    const events = [];
    globalThis.fetch = mockSseFetch(makeChunks());

    const result = await generateTextStream({
      messages: [],
      onChunk: (c) => events.push(c),
    });

    const reasoning = events.filter((e) => e.type === 'reasoning');
    const content = events.filter((e) => e.type === 'content');
    assert.deepEqual(reasoning.map((e) => e.data), ['思考A', '思考B']);
    assert.equal(reasoning[1].fullText, '思考A思考B');
    assert.deepEqual(content.map((e) => e.data), ['第一行\n', '第二行']);
    assert.equal(content[1].fullText, '第一行\n第二行');
    assert.equal(result.text, '第一行\n第二行');
    assert.equal(result.reasoning, '思考A思考B');
    assert.equal(result.usage.total_tokens, 42);
  });

  test('模型与 usage：响应实际模型优先，缺字段 usage 安全保留', async () => {
    effectiveConfig = { baseUrl: 'https://mock.local/v1', apiKey: 'test-key', model: 'requested-model' };
    const generateTextStream = loadGenerateTextStream(1000);
    globalThis.fetch = mockSseFetch([
      sse({ model: 'actual-model', choices: [{ delta: { content: 'a' } }], usage: { total_tokens: 7 } }),
      sse({ model: 'actual-model', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);

    const result = await generateTextStream({ messages: [], onChunk: () => {} });

    assert.equal(result.model, 'actual-model');
    assert.deepEqual(result.usage, { total_tokens: 7 });
  });

  test('模型回退：响应未返回 chunk.model 时成功结果使用配置模型', async () => {
    effectiveConfig = { baseUrl: 'https://mock.local/v1', apiKey: 'test-key', model: 'configured-model' };
    const generateTextStream = loadGenerateTextStream(1000);
    globalThis.fetch = mockSseFetch([
      sse({ choices: [{ delta: { content: 'a' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);

    const result = await generateTextStream({ messages: [], onChunk: () => {} });

    assert.equal(result.model, 'configured-model');
  });

  test('模型回退：响应未返回 chunk.model 时 timeout error 使用配置模型', async () => {
    effectiveConfig = { baseUrl: 'https://mock.local/v1', apiKey: 'test-key', model: 'configured-model' };
    const generateTextStream = loadGenerateTextStream(500, 60);
    globalThis.fetch = mockSseFetch([
      sse({ choices: [{ delta: { content: 'a' } }] }),
    ], { holdOpen: true });

    let streamError;
    try {
      await generateTextStream({ messages: [], onChunk: () => {} });
    } catch (error) {
      streamError = error;
    }

    assert.equal(streamError?.code, 'AI_STREAM_TOTAL_TIMEOUT');
    assert.equal(streamError?.model, 'configured-model');
  });

  test('总超时错误携带当前尝试已解析的实际模型与部分 usage', async () => {
    const generateTextStream = loadGenerateTextStream(500, 60);
    globalThis.fetch = mockSseFetch([
      sse({ model: 'partial-model', choices: [{ delta: { content: 'a' } }], usage: { total_tokens: 7 } }),
    ], { holdOpen: true });

    let streamError;
    try {
      await generateTextStream({ messages: [], onChunk: () => {} });
    } catch (error) {
      streamError = error;
    }

    assert.equal(streamError?.code, 'AI_STREAM_TOTAL_TIMEOUT');
    assert.equal(streamError?.model, 'partial-model');
    assert.deepEqual(streamError?.usage, { total_tokens: 7 });
  });

  test('空闲超时：数据流挂起后按空闲阈值中断并返回类型化错误', async () => {
    const generateTextStream = loadGenerateTextStream(150);
    globalThis.fetch = mockSseFetch(
      [sse({ choices: [{ delta: { reasoning_content: '开始思考' } }] })],
      { holdOpen: true }
    );

    const startedAt = Date.now();
    let streamError;
    try {
      await generateTextStream({ messages: [], onChunk: () => {} });
    } catch (error) {
      streamError = error;
    }
    const elapsed = Date.now() - startedAt;
    assert.equal(streamError?.code, 'AI_STREAM_IDLE_TIMEOUT');
    assert.ok(elapsed < 5000, `应在空闲超时后快速中断，实际 ${elapsed}ms`);
  });

  test('总超时：上游持续活跃但超过绝对截止时间时中断', async () => {
    const generateTextStream = loadGenerateTextStream(100, 180);
    const lines = Array.from({ length: 12 }, (_, i) => sse({ choices: [{ delta: { content: `${i}\n` } }] }));
    globalThis.fetch = mockSseFetch(lines, { intervalMs: 35, holdOpen: true });
    let chunkCount = 0;

    let streamError;
    try {
      await Promise.race([
        generateTextStream({ messages: [], onChunk: () => { chunkCount += 1; } }),
        sleep(800).then(() => { throw new Error('total deadline not enforced'); }),
      ]);
    } catch (error) {
      streamError = error;
    }

    assert.equal(streamError?.code, 'AI_STREAM_TOTAL_TIMEOUT');
    assert.ok(chunkCount >= 2, `截止前应持续收到数据，实际 ${chunkCount} chunks`);
  });

  test('总超时与空闲超时时同刻到期，按本次 timer 选中的类型确定结果', async () => {
    const generateTextStream = loadGenerateTextStream(120, 240000);
    globalThis.fetch = mockSseFetch(
      [sse({ choices: [{ delta: { content: 'a' } }] })],
      { holdOpen: true }
    );
    const realNow = Date.now;
    const fixedNow = 1000;
    Date.now = () => fixedNow;

    let streamError;
    try {
      await generateTextStream({
        messages: [],
        onChunk: () => {},
        deadlineAt: fixedNow + 120,
      });
    } catch (error) {
      streamError = error;
    } finally {
      Date.now = realNow;
    }

    assert.equal(streamError?.code, 'AI_STREAM_TOTAL_TIMEOUT');
  });

  test('总超时：配置解析阶段也受绝对截止时间约束', async () => {
    aiConfig.getEffectiveConfig = () => new Promise(() => {});
    const generateTextStream = loadGenerateTextStream(1000, 80);

    let streamError;
    try {
      await Promise.race([
        generateTextStream({ messages: [], onChunk: () => {} }),
        sleep(400).then(() => { throw new Error('total deadline not enforced during config load'); }),
      ]);
    } catch (error) {
      streamError = error;
    } finally {
      aiConfig.getEffectiveConfig = () => ({ ...effectiveConfig });
    }

    assert.equal(streamError?.code, 'AI_STREAM_TOTAL_TIMEOUT');
  });

  test('数据持续流动时空闲计时器持续重置', async () => {
    const generateTextStream = loadGenerateTextStream(100);
    const lines = Array.from({ length: 6 }, (_, i) => sse({ choices: [{ delta: { content: `第${i + 1}行\n` } }] }));
    globalThis.fetch = mockSseFetch(lines, { intervalMs: 60 });

    const result = await generateTextStream({ messages: [], onChunk: () => {} });
    assert.equal(result.text, '第1行\n第2行\n第3行\n第4行\n第5行\n第6行\n');
  });

  test('thinking_budget 配置透传到请求体；未配置时不携带该字段', async () => {
    effectiveConfig = { baseUrl: 'https://mock.local/v1', apiKey: 'test-key', model: 'test-model', thinkingBudget: 400 };
    const generateTextStream = loadGenerateTextStream(1000);
    globalThis.fetch = mockSseFetch(makeChunks());
    await generateTextStream({ messages: [], onChunk: () => {} });
    assert.equal(JSON.parse(lastRequestBody).thinking_budget, 400);

    effectiveConfig = { baseUrl: 'https://mock.local/v1', apiKey: 'test-key', model: 'test-model' };
    globalThis.fetch = mockSseFetch(makeChunks());
    await generateTextStream({ messages: [], onChunk: () => {} });
    assert.equal('thinking_budget' in JSON.parse(lastRequestBody), false);
  });
});
