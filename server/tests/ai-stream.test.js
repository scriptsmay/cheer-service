'use strict';

/**
 * generateTextStream 单元测试
 * - SSE 增量解析（reasoning_content / content delta）
 * - 空闲超时语义：无数据间隔超时中断，数据持续流动不因总时长中断
 *
 * 通过 require.cache 替换 ai-config.getEffectiveConfig 打桩上游配置；
 * mock fetch 必须尊重 AbortSignal（abort 时 error 掉响应流）——与真实 undici 行为一致，
 * 否则空闲超时中断在 mock 里永远不会发生。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const aiConfigPath = require.resolve('../src/services/ai-config');
const aiConfig = require(aiConfigPath);
aiConfig.getEffectiveConfig = () => ({
  baseUrl: 'https://mock.local/v1',
  apiKey: 'test-key',
  model: 'test-model',
});

// 每个用例可指定不同空闲阈值（env.js 在 require 时读取）
function loadGenerateTextStream(idleMs) {
  process.env.AI_STREAM_IDLE_TIMEOUT_MS = String(idleMs);
  delete require.cache[require.resolve('../src/config/env.js')];
  delete require.cache[require.resolve('../src/services/ai.js')];
  const ai = require('../src/services/ai.js');
  return ai.generateTextStream;
}

const encoder = new TextEncoder();
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 构造 mock fetch：返回 SSE Response。
 * - lines 逐条下发，每条间隔 intervalMs
 * - holdOpen=true 时发完不关闭（模拟上游挂起，考验空闲超时）
 * - 监听 opts.signal：abort 时以 signal.reason error 掉流（等价真实 fetch 行为）
 */
function mockSseFetch(lines, { intervalMs = 0, holdOpen = false } = {}) {
  let streamController = null;
  let stopped = false;

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

  test('空闲超时：数据流挂起后按空闲阈值中断（不再受总时长墙钟限制）', async () => {
    const generateTextStream = loadGenerateTextStream(150);
    globalThis.fetch = mockSseFetch(
      [sse({ choices: [{ delta: { reasoning_content: '开始思考' } }] })],
      { holdOpen: true }
    );

    const startedAt = Date.now();
    await assert.rejects(
      generateTextStream({ messages: [], onChunk: () => {} }),
      /空闲超时/
    );
    const elapsed = Date.now() - startedAt;
    // 只发了一条数据后挂起：应在空闲阈值(150ms)量级中断，而不是等满 180s
    assert.ok(elapsed < 5000, `应在空闲超时后快速中断，实际 ${elapsed}ms`);
  });

  test('数据持续流动时不受总时长限制：间隔小于空闲阈值的长流正常完成', async () => {
    const generateTextStream = loadGenerateTextStream(100);
    // 6 条 × 60ms 间隔 ≈ 360ms 总时长，远超旧版墙钟口径；空闲间隔 60ms < 100ms 阈值
    const lines = Array.from({ length: 6 }, (_, i) => sse({ choices: [{ delta: { content: `第${i + 1}行\n` } }] }));
    globalThis.fetch = mockSseFetch(lines, { intervalMs: 60 });

    const result = await generateTextStream({ messages: [], onChunk: () => {} });
    assert.equal(result.text, '第1行\n第2行\n第3行\n第4行\n第5行\n第6行\n');
  });
});
