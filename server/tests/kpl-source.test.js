'use strict';

// Set env vars before requiring modules
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { createKplSource, normalizeState } = require('../src/lib/kpl-source');

const silentLogger = { log() {}, warn() {}, error() {} };

/** 构造一个最小的 fetch Response 替身 */
function fakeResponse(status, { body = '', etag = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
    text: async () => body,
  };
}

/** 记录请求并按脚本返回响应的 fetch 替身 */
function scriptedFetch(handlers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    const handler = handlers.find((h) => url.includes(h.match));
    if (!handler) throw new Error(`unexpected URL: ${url}`);
    if (typeof handler.reply === 'function') return handler.reply(url, options);
    return handler.reply;
  };
  impl.calls = calls;
  return impl;
}

describe('normalizeState', () => {
  test('accepts legacy numeric timestamp string', () => {
    const state = normalizeState('1737000000000');
    assert.strictEqual(state.timestampMs, 1737000000000);
    assert.deepStrictEqual(state.etags, {});
  });

  test('accepts JSON state object', () => {
    const state = normalizeState({ timestampMs: 123, etags: { 'a.json': 'W/"1"' } });
    assert.strictEqual(state.timestampMs, 123);
    assert.strictEqual(state.etags['a.json'], 'W/"1"');
  });

  test('handles null / garbage as first sync', () => {
    for (const input of [null, undefined, '', 'not-a-number']) {
      const state = normalizeState(input);
      assert.strictEqual(state.timestampMs, 0);
      assert.deepStrictEqual(state.etags, {});
    }
  });
});

describe('kpl-source · local 模式', () => {
  test('readText / readKplJson 从本地目录读取', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kpl-src-'));
    await fs.mkdir(path.join(dir, 'data', 'latest'), { recursive: true });
    await fs.writeFile(path.join(dir, 'data', 'latest', 'current-season.json'),
      JSON.stringify({ current: 'KPL2026S2' }));

    const source = createKplSource({ source: 'local', localDir: dir, logger: silentLogger });
    const raw = await source.readText('data/latest/current-season.json');
    assert.match(raw, /KPL2026S2/);
    const json = await source.readKplJson('data/latest/current-season.json');
    assert.strictEqual(json.current, 'KPL2026S2');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('缺失文件返回 null 而不抛错', async () => {
    const source = createKplSource({ source: 'local', localDir: os.tmpdir(), logger: silentLogger });
    assert.strictEqual(await source.readText('data/nope.json'), null);
    assert.strictEqual(await source.readKplJson('data/nope.json'), null);
  });

  test('非法 JSON 返回 null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kpl-src-'));
    await fs.writeFile(path.join(dir, 'bad.json'), '{not json');
    const source = createKplSource({ source: 'local', localDir: dir, logger: silentLogger });
    assert.strictEqual(await source.readKplJson('bad.json'), null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('checkChanged 按 mtime 比对：无状态视为变更、时间戳晚于 mtime 视为未变', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kpl-src-'));
    const season = 'KPL2026S2';
    const target = path.join(dir, 'data', 'derived', season, 'overview.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{}');

    const source = createKplSource({ source: 'local', localDir: dir, logger: silentLogger });

    const first = await source.checkChanged(season, null);
    assert.strictEqual(first.changed, true, '首次同步（无状态）应视为有变更');
    assert.ok(first.state.timestampMs > 0);

    // 用「未来时间戳」显式构造未变更场景，避免依赖写入与检查的毫秒先后
    const notChanged = await source.checkChanged(season, {
      timestampMs: Date.now() + 60_000,
      etags: {},
    });
    assert.strictEqual(notChanged.changed, false, '状态时间戳晚于文件 mtime 应视为未变更');

    const legacy = await source.checkChanged(season, '0');
    assert.strictEqual(legacy.changed, true, '旧版纯时间戳 0 应视为有变更');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('describeSource 输出 local 前缀路径', () => {
    const source = createKplSource({ source: 'local', localDir: '/app/kpl-data-daily', logger: silentLogger });
    assert.match(source.describeSource('data/derived/KPL2026S2/overview.json'), /^local:.*overview\.json$/);
  });
});


describe('kpl-source · github 模式', () => {
  const RAW_BASE = 'https://raw.example.com/scriptsmay/kpl_data_daily/main';

  test('readText / readKplJson 走 raw URL', async () => {
    const fetchImpl = scriptedFetch([
      { match: 'current-season.json', reply: fakeResponse(200, { body: '{"current":"KPL2026S2"}' }) },
    ]);
    const source = createKplSource({ source: 'github', rawBase: RAW_BASE, fetchImpl, logger: silentLogger });

    const json = await source.readKplJson('data/latest/current-season.json');
    assert.strictEqual(json.current, 'KPL2026S2');
    assert.strictEqual(fetchImpl.calls.length, 1);
    assert.strictEqual(fetchImpl.calls[0].url, `${RAW_BASE}/data/latest/current-season.json`);
  });

  test('404 返回 null 且不重试', async () => {
    const fetchImpl = scriptedFetch([{ match: 'overview.json', reply: fakeResponse(404) }]);
    const source = createKplSource({
      source: 'github', rawBase: RAW_BASE, fetchImpl, logger: silentLogger, retries: 2,
    });
    assert.strictEqual(await source.readKplJson('data/derived/KPL2026S2/overview.json'), null);
    assert.strictEqual(fetchImpl.calls.length, 1, '404 属确定性失败，不该重试');
  });

  test('网络异常按 retries 重试后返回 null', async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      throw new Error('ECONNRESET');
    };
    const source = createKplSource({
      source: 'github', rawBase: RAW_BASE, fetchImpl, logger: silentLogger, retries: 1, timeoutMs: 1000,
    });
    const result = await source.readText('data/latest/current-season.json');
    assert.strictEqual(result, null);
    assert.strictEqual(attempts, 2, 'retries=1 应共尝试 2 次');
  });

  test('checkChanged：无历史 ETag 视为变更，304 视为未变，新 ETag 视为变更', async () => {
    const season = 'KPL2026S2';
    const overviewEtag = 'W/"aaa"';
    const scheduleEtag = 'W/"bbb"';

    // 第一轮：无状态 → 全量 200，应判定有变更并记录 ETag
    const firstFetch = scriptedFetch([
      { match: 'overview.json', reply: fakeResponse(200, { body: '{}', etag: overviewEtag }) },
      { match: 'schedule.json', reply: fakeResponse(200, { body: '{}', etag: scheduleEtag }) },
    ]);
    const source = createKplSource({ source: 'github', rawBase: RAW_BASE, fetchImpl: firstFetch, logger: silentLogger });
    const first = await source.checkChanged(season, null);
    assert.strictEqual(first.changed, true);
    assert.strictEqual(first.state.etags[path.join('data', 'derived', season, 'overview.json')], overviewEtag);

    // 第二轮：携带 ETag → 304，应判定未变更
    const sameEtagFetch = scriptedFetch([
      { match: 'overview.json', reply: fakeResponse(304, { etag: overviewEtag }) },
      { match: 'schedule.json', reply: fakeResponse(304, { etag: scheduleEtag }) },
    ]);
    const sourceSame = createKplSource({
      source: 'github', rawBase: RAW_BASE, fetchImpl: sameEtagFetch, logger: silentLogger,
    });
    const unchanged = await sourceSame.checkChanged(season, first.state);
    assert.strictEqual(unchanged.changed, false, '304 应判定未变更');
    assert.match(sameEtagFetch.calls[0].headers['If-None-Match'], /W\/"aaa"/);

    // 第三轮：ETag 变化 → 200 新 ETag，应判定有变更
    const changedFetch = scriptedFetch([
      { match: 'overview.json', reply: fakeResponse(200, { body: '{}', etag: 'W/"new"' }) },
      { match: 'schedule.json', reply: fakeResponse(304, { etag: scheduleEtag }) },
    ]);
    const sourceChanged = createKplSource({
      source: 'github', rawBase: RAW_BASE, fetchImpl: changedFetch, logger: silentLogger,
    });
    const changed = await sourceChanged.checkChanged(season, first.state);
    assert.strictEqual(changed.changed, true);
    assert.strictEqual(changed.state.etags[path.join('data', 'derived', season, 'overview.json')], 'W/"new"');
  });

  test('checkChanged：请求异常时保守判定为有变更', async () => {
    const fetchImpl = async () => { throw new Error('ETIMEDOUT'); };
    const source = createKplSource({
      source: 'github', rawBase: RAW_BASE, fetchImpl, logger: silentLogger, retries: 0, timeoutMs: 1000,
    });
    const result = await source.checkChanged('KPL2026S2', { timestampMs: Date.now(), etags: {} });
    assert.strictEqual(result.changed, true, '读不到时应保守同步，避免漏数据');
  });

  test('describeSource 输出 github 前缀 URL', () => {
    const source = createKplSource({ source: 'github', rawBase: RAW_BASE, logger: silentLogger });
    assert.strictEqual(
      source.describeSource('data/derived/KPL2026S2/overview.json'),
      `github:${RAW_BASE}/data/derived/KPL2026S2/overview.json`,
    );
  });

  test('非法 KPL_SOURCE 取值直接报错', () => {
    assert.throws(() => createKplSource({ source: 'ftp' }), /KPL_SOURCE 取值非法/);
  });
});

