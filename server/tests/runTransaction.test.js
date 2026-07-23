'use strict';

/**
 * runTransaction 返回值传播测试
 *
 * 核心问题：runTransaction() 调用 fn() 但未返回其结果，
 * 导致 /api/ask、/api/checkins、/api/cheer 的额度检查/限流始终失败。
 *
 * 此测试通过 mock MongoDB session 验证返回值正确传播。
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ── Mock 基础设施 ──

let originalRequire;
let mockSession;
let withTransactionCallback;

function setupMock() {
  mockSession = {
    withTransaction: async (fn) => {
      withTransactionCallback = fn;
      return await fn();
    },
    endSession: async () => {},
  };

  const mockDb = {
    collection: (name) => ({
      findOne: async () => null,
      updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
      insertOne: async () => ({ insertedId: 'mock-id' }),
      deleteOne: async () => ({ deletedCount: 0 }),
      find: () => ({
        toArray: async () => [],
        limit: () => ({ toArray: async () => [] }),
      }),
    }),
  };

  originalRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'mongodb') {
      return {
        MongoClient: class {
          async connect() {}
          db() { return mockDb; }
          startSession() { return mockSession; }
        },
      };
    }
    return originalRequire.apply(this, arguments);
  };
}

function teardownMock() {
  if (originalRequire) {
    Module.prototype.require = originalRequire;
    originalRequire = null;
  }
}

// ── 清除缓存以确保 require 时使用 mock ──
function clearCache() {
  const paths = [
    require.resolve('../src/db/mongo.js'),
    require.resolve('../src/config/env.js'),
  ];
  for (const p of paths) {
    delete require.cache[p];
  }
}

// 设置环境变量以避免 env.js 报错
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '赌博,色情,自杀,暴力,恐怖,毒品,诈骗,传销,政治敏感,反动,违法,违规';

describe('runTransaction 返回值传播', () => {
  beforeEach(() => {
    setupMock();
    clearCache();
  });

  afterEach(() => {
    teardownMock();
    clearCache();
  });

  test('返回 fn() 的对象结果', async () => {
    const { runTransaction, getDb } = require('../src/db/mongo');
    await getDb(); // 初始化 client

    const result = await runTransaction(async (tc) => {
      return { allowed: true, receiptId: 'test-123' };
    });

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.receiptId, 'test-123');
  });

  test('返回 fn() 的原始值 true', async () => {
    const { runTransaction, getDb } = require('../src/db/mongo');
    await getDb();

    const result = await runTransaction(async (tc) => {
      return true;
    });

    assert.strictEqual(result, true);
  });

  test('返回 fn() 的原始值 false（限流场景）', async () => {
    const { runTransaction, getDb } = require('../src/db/mongo');
    await getDb();

    const result = await runTransaction(async (tc) => {
      return false;
    });

    assert.strictEqual(result, false);
  });

  test('返回 fn() 的原始值 null（未找到场景）', async () => {
    const { runTransaction, getDb } = require('../src/db/mongo');
    await getDb();

    const result = await runTransaction(async (tc) => {
      return null;
    });

    assert.strictEqual(result, null);
  });

  test('事务内 collection 操作可调用', async () => {
    const { runTransaction, getDb } = require('../src/db/mongo');
    await getDb();

    const result = await runTransaction(async (tc) => {
      const col = tc('usage_limits');
      const docResult = await col.doc('test-id').get();
      assert.ok(docResult.data !== undefined);
      return { ok: true };
    });

    assert.strictEqual(result.ok, true);
  });

  test('session 在事务结束后被正确关闭', async () => {
    const { runTransaction, getDb } = require('../src/db/mongo');
    await getDb();

    let endSessionCalled = false;
    const originalEndSession = mockSession.endSession;
    mockSession.endSession = async () => { endSessionCalled = true; };

    await runTransaction(async () => 'done');

    assert.strictEqual(endSessionCalled, true);
    mockSession.endSession = originalEndSession;
  });
});
