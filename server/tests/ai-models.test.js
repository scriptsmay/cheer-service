'use strict';

// 设置基础环境变量，避免 ai-config 依赖的 env 模块读空
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const aiConfig = require('../src/services/ai-config');
const { fetchAvailableModels, resolveModelsUrl, isPrivateOrLocalhost } =
  require('../src/services/ai-models');
const dns = require('node:dns').promises;

// 默认生效配置（可被各测试覆盖）
function defaultCfg() {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-effective',
    model: 'deepseek-chat',
    _source: 'env',
  };
}

let fetchCalls = [];
let savedFetch = global.fetch;
const savedDnsLookup = dns.lookup;

beforeEach(() => {
  aiConfig.getEffectiveConfig = defaultCfg;
  fetchCalls = [];
  dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
});

afterEach(() => {
  global.fetch = savedFetch;
  dns.lookup = savedDnsLookup;
});

// ── resolveModelsUrl 单元测试（不依赖 fetch）──
describe('resolveModelsUrl', () => {
  test('标准 URL 拼 /models', () => {
    assert.strictEqual(resolveModelsUrl('https://api.x.com/v1'), 'https://api.x.com/v1/models');
  });
  test('去除尾部斜杠', () => {
    assert.strictEqual(resolveModelsUrl('https://api.x.com/v1/'), 'https://api.x.com/v1/models');
  });
  test('去除 /chat/completions 后缀', () => {
    assert.strictEqual(
      resolveModelsUrl('https://api.x.com/v1/chat/completions'),
      'https://api.x.com/v1/models'
    );
  });
  test('清空 query / hash', () => {
    assert.strictEqual(
      resolveModelsUrl('https://api.x.com/v1?token=1#frag'),
      'https://api.x.com/v1/models'
    );
  });
  test('空 URL 抛 NO_BASE_URL', () => {
    assert.throws(() => resolveModelsUrl(''), (e) => e.code === 'NO_BASE_URL');
    assert.throws(() => resolveModelsUrl('   '), (e) => e.code === 'NO_BASE_URL');
  });
  test('非法协议抛 INVALID_URL', () => {
    assert.throws(() => resolveModelsUrl('ftp://api.x.com/v1'), (e) => e.code === 'INVALID_URL');
  });
  test('已含 /models 抛 INVALID_URL', () => {
    assert.throws(() => resolveModelsUrl('https://api.x.com/v1/models'), (e) => e.code === 'INVALID_URL');
    assert.throws(() => resolveModelsUrl('https://api.x.com/v1/x/models/y'), (e) => e.code === 'INVALID_URL');
  });
});

// ── isPrivateOrLocalhost 单元测试 ──
describe('isPrivateOrLocalhost', () => {
  test('localhost 与 0.0.0.0/环回/私网/链路本地 命中', () => {
    assert.strictEqual(isPrivateOrLocalhost('localhost'), true);
    assert.strictEqual(isPrivateOrLocalhost('127.0.0.1'), true);
    assert.strictEqual(isPrivateOrLocalhost('0.0.0.0'), true);
    assert.strictEqual(isPrivateOrLocalhost('10.0.0.5'), true);
    assert.strictEqual(isPrivateOrLocalhost('172.16.4.4'), true);
    assert.strictEqual(isPrivateOrLocalhost('172.32.0.1'), false); // 超出 172.16/12
    assert.strictEqual(isPrivateOrLocalhost('192.168.1.1'), true);
    assert.strictEqual(isPrivateOrLocalhost('169.254.169.254'), true); // 云元数据
    assert.strictEqual(isPrivateOrLocalhost('100.64.0.1'), true); // CGNAT
  });
  test('公网 IP 不命中', () => {
    assert.strictEqual(isPrivateOrLocalhost('8.8.8.8'), false);
    assert.strictEqual(isPrivateOrLocalhost('1.2.3.4'), false);
  });
  test('IPv6 环回/链路本地/唯一本地 命中', () => {
    assert.strictEqual(isPrivateOrLocalhost('[::1]'), true);
    assert.strictEqual(isPrivateOrLocalhost('[fe80::1]'), true);
    assert.strictEqual(isPrivateOrLocalhost('[fc00::1]'), true);
    assert.strictEqual(isPrivateOrLocalhost('[2606:4700::1]'), false);
  });
  test('普通域名不命中（交给下游兜底）', () => {
    assert.strictEqual(isPrivateOrLocalhost('api.deepseek.com'), false);
  });
});

// ── fetchAvailableModels 集成（mock fetch）──
describe('fetchAvailableModels', () => {
  test('标准 {data:[{id}]} 解析出模型名', async () => {
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, ['a', 'b']);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].url, 'https://api.deepseek.com/v1/models');
    assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer sk-effective');
  });

  test('字符串项形态的 data 也解析', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ data: ['x', 'y'] }), { status: 200 });
    const r = await fetchAvailableModels({});
    assert.deepStrictEqual(r.models, ['x', 'y']);
  });

  test('非数组 data 视为失败', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ data: 'not-array' }), { status: 200 });
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
  });

  test('非 JSON 响应视为失败', async () => {
    global.fetch = async () => new Response('plain text', { status: 200 });
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
  });

  test('使用表单传入的 baseUrl 与 apiKey', async () => {
    const r = await fetchAvailableModels({ baseUrl: 'https://other.com/openai/v1', apiKey: 'sk-new' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fetchCalls[0].url, 'https://other.com/openai/v1/models');
    assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer sk-new');
  });

  test('缺 key 且无可回退 key 抛 NO_KEY', async () => {
    aiConfig.getEffectiveConfig = () => ({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'm', _source: 'env' });
    await assert.rejects(() => fetchAvailableModels({}), (e) => e.code === 'NO_KEY');
    assert.strictEqual(fetchCalls.length, 0);
  });

  test('缺 baseUrl 抛 NO_BASE_URL 且不调用 fetch', async () => {
    aiConfig.getEffectiveConfig = () => ({ baseUrl: '', apiKey: 'sk', model: 'm', _source: 'env' });
    await assert.rejects(() => fetchAvailableModels({}), (e) => e.code === 'NO_BASE_URL');
    assert.strictEqual(fetchCalls.length, 0);
  });

  test('非法协议抛 INVALID_URL 且不调用 fetch', async () => {
    await assert.rejects(
      () => fetchAvailableModels({ baseUrl: 'ftp://api.x.com/v1', apiKey: 'sk' }),
      (e) => e.code === 'INVALID_URL'
    );
    assert.strictEqual(fetchCalls.length, 0);
  });

  test('localhost 抛 SSRF_BLOCKED 且不调用 fetch', async () => {
    await assert.rejects(
      () => fetchAvailableModels({ baseUrl: 'http://localhost:8080/v1', apiKey: 'sk' }),
      (e) => e.code === 'SSRF_BLOCKED'
    );
    assert.strictEqual(fetchCalls.length, 0);
  });

  test('私网地址抛 SSRF_BLOCKED 且不调用 fetch', async () => {
    await assert.rejects(
      () => fetchAvailableModels({ baseUrl: 'http://192.168.1.1/v1', apiKey: 'sk' }),
      (e) => e.code === 'SSRF_BLOCKED'
    );
    assert.strictEqual(fetchCalls.length, 0);
  });

  test('新端点未提供 key 抛 KEY_REQUIRED_FOR_NEW_ENDPOINT 且不调用 fetch', async () => {
    await assert.rejects(
      () => fetchAvailableModels({ baseUrl: 'https://new.endpoint.com/v1' }),
      (e) => e.code === 'KEY_REQUIRED_FOR_NEW_ENDPOINT'
    );
    assert.strictEqual(fetchCalls.length, 0);
  });

  test('新端点提供了 key 则使用新 key', async () => {
    const r = await fetchAvailableModels({ baseUrl: 'https://new.endpoint.com/v1', apiKey: 'sk-fresh' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer sk-fresh');
  });

  test('表单 baseUrl 与生效 baseUrl 相同则复用已保存 key', async () => {
    const r = await fetchAvailableModels({ baseUrl: 'https://api.deepseek.com/v1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer sk-effective');
  });

  test('端点返回 401 透出 error.message', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 });
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Incorrect API key/);
  });

  test('模型数量超过上限被截断', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ id: 'm' + i }));
    global.fetch = async () => new Response(JSON.stringify({ data: many }), { status: 200 });
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.models.length, 1000);
  });

  test('超大响应体被拒绝', async () => {
    global.fetch = async () =>
      new Response('x'.repeat(6 * 1024 * 1024), { status: 200 });
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /响应体过大/);
  });
});
