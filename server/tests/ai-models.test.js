'use strict';

// 设置基础环境变量，避免 ai-config 依赖的 env 模块读空
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const aiConfig = require('../src/services/ai-config');
const aiModels = require('../src/services/ai-models');
const { fetchAvailableModels, resolveModelsUrl, isPrivateOrLocalhost } = aiModels;
const { impl, requestViaAddress, readCappedBody } = aiModels.__test;
const dns = require('node:dns').promises;
const http = require('node:http');

// 默认生效配置（可被各测试覆盖）
function defaultCfg() {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-effective',
    model: 'deepseek-chat',
    _source: 'env',
  };
}

// 模拟 node http 响应（statusCode + 流式 body），供 impl.requestViaAddress 的 mock 返回
function fakeRes(status, body) {
  return {
    statusCode: status,
    resume() {},
    destroy() {},
    on(ev, cb) {
      if (ev === 'data') setImmediate(() => cb(Buffer.from(body)));
      if (ev === 'end') setImmediate(cb);
      return this;
    },
  };
}

let requestCalls = [];
let dnsCalls = [];
let savedRequestImpl;
const savedDnsLookup = dns.lookup;

beforeEach(() => {
  aiConfig.getEffectiveConfig = defaultCfg;
  requestCalls = [];
  dnsCalls = [];
  // DNS 只 mock 一次解析：实现应当解析一次后用返回的 IP 直连
  dns.lookup = async (hostname, opts) => {
    dnsCalls.push(hostname);
    return [{ address: '8.8.8.8', family: 4 }];
  };
  savedRequestImpl = impl.requestViaAddress;
  impl.requestViaAddress = async (modelsUrl, address, opts) => {
    requestCalls.push({ modelsUrl, address, opts });
    return fakeRes(200, JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }));
  };
});

afterEach(() => {
  impl.requestViaAddress = savedRequestImpl;
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
  test('IPv4-mapped IPv6 还原为 IPv4 判定（防绕过）', () => {
    // 点分形式
    assert.strictEqual(isPrivateOrLocalhost('::ffff:127.0.0.1'), true);
    assert.strictEqual(isPrivateOrLocalhost('::ffff:10.0.0.1'), true);
    assert.strictEqual(isPrivateOrLocalhost('::ffff:192.168.0.1'), true);
    assert.strictEqual(isPrivateOrLocalhost('::ffff:169.254.169.254'), true); // 云元数据
    assert.strictEqual(isPrivateOrLocalhost('[::ffff:10.0.0.1]'), true); // 带括号形式
    assert.strictEqual(isPrivateOrLocalhost('::ffff:8.8.8.8'), false); // 公网映射仍放行
    // 十六进制形式（::ffff:aabb:ccdd = a.b.c.d）
    assert.strictEqual(isPrivateOrLocalhost('::ffff:7f00:1'), true); // 127.0.0.1
    assert.strictEqual(isPrivateOrLocalhost('::ffff:0a00:0001'), true); // 10.0.0.1
    assert.strictEqual(isPrivateOrLocalhost('::ffff:808:808'), false); // 8.8.8.8
  });
  test('普通域名不命中（交给下游兜底）', () => {
    assert.strictEqual(isPrivateOrLocalhost('api.deepseek.com'), false);
  });
});

// ── fetchAvailableModels 集成（mock 请求实现 + dns.lookup）──
describe('fetchAvailableModels', () => {
  test('解析一次后对解析出的 IP 直连（防 DNS rebinding）', async () => {
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, ['a', 'b']);
    assert.strictEqual(dnsCalls.length, 1, '整个请求只应做一次 DNS 解析');
    assert.strictEqual(requestCalls.length, 1);
    assert.strictEqual(requestCalls[0].address, '8.8.8.8', '应用解析出的 IP 建连');
    assert.strictEqual(requestCalls[0].modelsUrl, 'https://api.deepseek.com/v1/models');
    assert.strictEqual(requestCalls[0].opts.headers.Authorization, 'Bearer sk-effective');
    // Host 头由真实 requestViaAddress 内部拼装并保留原域名，在下方本地服务器用例中验证
  });

  test('字符串项形态的 data 也解析', async () => {
    impl.requestViaAddress = async () => fakeRes(200, JSON.stringify({ data: ['x', 'y'] }));
    const r = await fetchAvailableModels({});
    assert.deepStrictEqual(r.models, ['x', 'y']);
  });

  test('非数组 data 视为失败', async () => {
    impl.requestViaAddress = async () => fakeRes(200, JSON.stringify({ data: 'not-array' }));
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
  });

  test('非 JSON 响应视为失败', async () => {
    impl.requestViaAddress = async () => fakeRes(200, 'plain text');
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
  });

  test('重定向被拒绝（防绕过解析校验）', async () => {
    impl.requestViaAddress = async () => fakeRes(302, '');
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /重定向/);
  });

  test('使用表单传入的 baseUrl 与 apiKey', async () => {
    const r = await fetchAvailableModels({ baseUrl: 'https://other.com/openai/v1', apiKey: 'sk-new' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(requestCalls[0].modelsUrl, 'https://other.com/openai/v1/models');
    assert.strictEqual(requestCalls[0].opts.headers.Authorization, 'Bearer sk-new');
  });

  test('缺 key 且无可回退 key 抛 NO_KEY', async () => {
    aiConfig.getEffectiveConfig = () => ({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'm', _source: 'env' });
    await assert.rejects(() => fetchAvailableModels({}), (e) => e.code === 'NO_KEY');
    assert.strictEqual(requestCalls.length, 0);
  });

  test('缺 baseUrl 抛 NO_BASE_URL 且不发起请求', async () => {
    aiConfig.getEffectiveConfig = () => ({ baseUrl: '', apiKey: 'sk', model: 'm', _source: 'env' });
    await assert.rejects(() => fetchAvailableModels({}), (e) => e.code === 'NO_BASE_URL');
    assert.strictEqual(requestCalls.length, 0);
  });

  test('非法协议抛 INVALID_URL 且不发起请求', async () => {
    await assert.rejects(
      () => fetchAvailableModels({ baseUrl: 'ftp://api.x.com/v1', apiKey: 'sk' }),
      (e) => e.code === 'INVALID_URL'
    );
    assert.strictEqual(requestCalls.length, 0);
  });

  test('localhost 抛 SSRF_BLOCKED 且不发起请求', async () => {
    await assert.rejects(
      () => fetchAvailableModels({ baseUrl: 'http://localhost:8080/v1', apiKey: 'sk' }),
      (e) => e.code === 'SSRF_BLOCKED'
    );
    assert.strictEqual(requestCalls.length, 0);
  });

  test('私网地址抛 SSRF_BLOCKED 且不发起请求', async () => {
    await assert.rejects(
      () => fetchAvailableModels({ baseUrl: 'http://192.168.1.1/v1', apiKey: 'sk' }),
      (e) => e.code === 'SSRF_BLOCKED'
    );
    assert.strictEqual(requestCalls.length, 0);
  });

  test('域名解析到内网地址被拦截（校验的是解析结果）', async () => {
    dns.lookup = async () => [{ address: '10.0.0.1', family: 4 }];
    const r = await fetchAvailableModels({ baseUrl: 'https://evil.rebind.example/v1', apiKey: 'sk' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /内网/);
    assert.strictEqual(requestCalls.length, 0, '解析到内网时不应对其建连');
  });

  test('新端点未提供 key 抛 KEY_REQUIRED_FOR_NEW_ENDPOINT 且不发起请求', async () => {
    await assert.rejects(
      () => fetchAvailableModels({ baseUrl: 'https://new.endpoint.com/v1' }),
      (e) => e.code === 'KEY_REQUIRED_FOR_NEW_ENDPOINT'
    );
    assert.strictEqual(requestCalls.length, 0);
  });

  test('新端点提供了 key 则使用新 key', async () => {
    const r = await fetchAvailableModels({ baseUrl: 'https://new.endpoint.com/v1', apiKey: 'sk-fresh' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(requestCalls[0].opts.headers.Authorization, 'Bearer sk-fresh');
  });

  test('表单 baseUrl 与生效 baseUrl 相同则复用已保存 key', async () => {
    const r = await fetchAvailableModels({ baseUrl: 'https://api.deepseek.com/v1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(requestCalls[0].opts.headers.Authorization, 'Bearer sk-effective');
  });

  test('端点返回 401 透出 error.message', async () => {
    impl.requestViaAddress = async () =>
      fakeRes(401, JSON.stringify({ error: { message: 'Incorrect API key' } }));
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Incorrect API key/);
  });

  test('模型数量超过上限被截断', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ id: 'm' + i }));
    impl.requestViaAddress = async () => fakeRes(200, JSON.stringify({ data: many }));
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.models.length, 1000);
  });

  test('超大响应体被拒绝', async () => {
    impl.requestViaAddress = async () => fakeRes(200, 'x'.repeat(6 * 1024 * 1024));
    const r = await fetchAvailableModels({});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /响应体过大/);
  });
});

// ── requestViaAddress + readCappedBody：真实本地 HTTP 服务器验证 IP 直连行为 ──
describe('requestViaAddress — IP 直连与 Host/SNI 保留', () => {
  test('对解析出的 IP 建连，Host 头保留原域名，路径与 query 正确', async () => {
    const received = {};
    const server = http.createServer((req, res) => {
      received.host = req.headers.host;
      received.url = req.url;
      received.auth = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = server.address().port;
      const modelsUrl = `http://models.example.test:${port}/v1/models?x=1`;
      const res = await requestViaAddress(modelsUrl, '127.0.0.1', {
        headers: { Authorization: 'Bearer sk-test' },
        timeoutMs: 5000,
      });
      assert.strictEqual(res.statusCode, 200);
      const text = await readCappedBody(res);
      assert.strictEqual(received.host, `models.example.test:${port}`, 'Host 头应为原域名而非 IP');
      assert.strictEqual(received.url, '/v1/models?x=1');
      assert.strictEqual(received.auth, 'Bearer sk-test');
      assert.strictEqual(JSON.parse(text).data[0].id, 'm1');
    } finally {
      server.close();
    }
  });
});
