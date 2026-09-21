'use strict';

/**
 * postgres.js 后端契约测试（注入 fake pool，无需真库）
 *
 * 验证 pg 后端与 mongo.js 同款 TCB 兼容面的 SQL 形态与行为语义：
 * doc 四操作 / where 链 / add（含事务内）/ runTransaction 提交与回滚 /
 * isTransactionConflict / 非法标识符拒绝。
 */

process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '赌博,色情';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { __test, runTransaction, isTransactionConflict, command, ping } = require('../src/db/postgres');

const { makeBackend, normalizeUri, generateId } = __test;

// ── fake pg 执行器：记录调用，返回罐头结果 ──
function fakeExecutor(rowsByCall) {
  const calls = [];
  const queue = (rowsByCall || []).slice();
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/gu, ' ').trim(), params });
      const next = queue.length ? queue.shift() : { rows: [] };
      return { rows: next.rows !== undefined ? next.rows : [], rowCount: next.rows ? next.rows.length : 0 };
    },
  };
}

describe('normalizeUri', () => {
  test('passes uri through unchanged (TLS 由 ssl 对象控制，防 sslmode 覆盖)', () => {
    assert.equal(normalizeUri('postgresql://u:p@h:5432/postgres'), 'postgresql://u:p@h:5432/postgres');
  });

  test('throws when uri missing', () => {
    assert.throws(() => normalizeUri(''), /POSTGRES_URI 未配置/);
  });
});

describe('collection — doc 操作', () => {
  let exec;
  beforeEach(() => {
    exec = fakeExecutor([{ rows: [{ data: { _id: 'a1', report_id: 'r1' } }] }]);
  });

  test('doc.get returns wrapped data rows', async () => {
    const { collection } = makeBackend(exec);
    const result = await collection('checkins').doc('a1').get();
    assert.deepEqual(result, { data: [{ _id: 'a1', report_id: 'r1' }] });
    assert.equal(exec.calls[0].sql, 'SELECT data FROM "cheer"."checkins" WHERE _id = $1');
    assert.deepEqual(exec.calls[0].params, ['a1']);
  });

  test('doc.get on missing doc returns empty data', async () => {
    const { collection } = makeBackend(fakeExecutor([{ rows: [] }]));
    const result = await collection('checkins').doc('missing').get();
    assert.deepEqual(result, { data: [] });
  });

  test('doc.set upserts with _id injected into data', async () => {
    const { collection } = makeBackend(exec);
    await collection('usage_limits').doc('rcpt1').set({ count: 1, status: 'pending' });
    const { sql, params } = exec.calls[0];
    assert.match(sql, /INSERT INTO "cheer"\."usage_limits" \(_id, data\) VALUES \(\$1, \$2::jsonb\)/);
    assert.match(sql, /ON CONFLICT \(_id\) DO UPDATE SET data = EXCLUDED\.data/);
    assert.equal(params[0], 'rcpt1');
    assert.deepEqual(JSON.parse(params[1]), { count: 1, status: 'pending', _id: 'rcpt1' });
  });

  test('doc.update merges via jsonb concat, no upsert', async () => {
    const { collection } = makeBackend(exec);
    await collection('checkins').doc('a1').update({ report_id: 'r2', updated_at: 'now' });
    const { sql, params } = exec.calls[0];
    assert.match(sql, /UPDATE "cheer"\."checkins" SET data = data \|\| \$2::jsonb WHERE _id = \$1/);
    assert.deepEqual(JSON.parse(params[1]), { report_id: 'r2', updated_at: 'now' });
  });

  test('doc.remove deletes by _id', async () => {
    const { collection } = makeBackend(exec);
    await collection('ai_reports').doc('x').remove();
    assert.equal(exec.calls[0].sql, 'DELETE FROM "cheer"."ai_reports" WHERE _id = $1');
    assert.deepEqual(exec.calls[0].params, ['x']);
  });
});

describe('collection — where 链与 add', () => {
  test('where().orderBy().limit().skip().get() composes one SQL', async () => {
    const exec = fakeExecutor([{ rows: [] }]);
    const { collection } = makeBackend(exec);
    await collection('ai_reports')
      .where({ subject_id: 'u1' })
      .orderBy('created_at', 'desc')
      .limit(50)
      .skip(10)
      .get();
    const { sql, params } = exec.calls[0];
    assert.equal(
      sql,
      'SELECT data FROM "cheer"."ai_reports" WHERE data->\'subject_id\' = $1::jsonb ORDER BY data->>\'created_at\' DESC LIMIT 50 OFFSET 10'
    );
    assert.deepEqual(params, ['"u1"']);
  });

  test('multiple orderBy fields keep insertion order', async () => {
    const exec = fakeExecutor([{ rows: [] }]);
    const { collection } = makeBackend(exec);
    await collection('t1').where({}).orderBy('a', 'asc').orderBy('b', 'desc').get();
    assert.match(exec.calls[0].sql, /ORDER BY data->>'a' ASC, data->>'b' DESC/);
  });

  test('count returns scalar number', async () => {
    const exec = fakeExecutor([{ rows: [{ n: 7 }] }]);
    const { collection } = makeBackend(exec);
    const n = await collection('checkins').where({ date: '2026-09-21' }).count();
    assert.equal(n, 7);
    assert.equal(exec.calls[0].sql, 'SELECT COUNT(*)::int AS n FROM "cheer"."checkins" WHERE data->\'date\' = $1::jsonb');
  });

  test('add generates 24-char hex id when missing and returns it', async () => {
    const exec = fakeExecutor([]);
    const { collection } = makeBackend(exec);
    const { id } = await collection('sync_snapshots').add({ type: 'daily', status: 'success' });
    assert.match(id, /^[0-9a-f]{24}$/u);
    assert.equal(generateId().length, 24);
    const { params } = exec.calls[0];
    assert.equal(params[0], id);
    assert.deepEqual(JSON.parse(params[1])._id, id);
  });

  test('add honors caller-provided _id', async () => {
    const exec = fakeExecutor([]);
    const { collection } = makeBackend(exec);
    const { id } = await collection('t1').add({ _id: 'explicit', x: 1 });
    assert.equal(id, 'explicit');
  });

  test('rejects illegal collection names', () => {
    const { collection } = makeBackend(fakeExecutor());
    assert.throws(() => collection('t; DROP TABLE x'), /非法集合名/);
    assert.throws(() => collection('123bad'), /非法集合名/);
  });
});

describe('runTransaction — 提交与回滚', () => {
  function fakePoolForTx() {
    const calls = [];
    const client = {
      calls,
      released: false,
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      },
      release() {
        client.released = true;
      },
    };
    return {
      calls,
      client,
      async connect() {
        return client;
      },
    };
  }

  test('commits and releases, propagates fn result with tc surface', async () => {
    const pool = fakePoolForTx();
    const result = await runTransaction(async (tc) => {
      await tc('checkins').doc('a1').set({ count: 1 });
      return { ok: true };
    }, { pool });
    assert.deepEqual(result, { ok: true });
    assert.equal(pool.calls[0].sql, 'BEGIN');
    assert.match(pool.calls[1].sql, /INSERT INTO "cheer"\."checkins"/);
    assert.equal(pool.calls[2].sql, 'COMMIT');
    assert.equal(pool.client.released, true);
  });

  test('rolls back and rethrows on fn error, still releases', async () => {
    const pool = fakePoolForTx();
    await assert.rejects(
      () => runTransaction(async () => {
        throw new Error('boom');
      }, { pool }),
      /boom/
    );
    const sqls = pool.calls.map((c) => c.sql);
    assert.deepEqual(sqls, ['BEGIN', 'ROLLBACK']);
    assert.equal(pool.client.released, true);
  });
});

describe('isTransactionConflict 与 command 透传', () => {
  test('recognizes pg 40001/40P01 only', () => {
    assert.equal(isTransactionConflict({ code: '40001' }), true);
    assert.equal(isTransactionConflict({ code: '40P01' }), true);
    assert.equal(isTransactionConflict({ code: '23505' }), false);
    assert.equal(isTransactionConflict(null), false);
    assert.equal(isTransactionConflict(new Error('WriteConflict')), false);
  });

  test('command operators mirror mongo.js surface', () => {
    assert.deepEqual(command.gte(1), { $gte: 1 });
    assert.deepEqual(command.lte(1), { $lte: 1 });
    assert.deepEqual(command.neq(1), { $ne: 1 });
    assert.deepEqual(command.in([1]), { $in: [1] });
    assert.deepEqual(command.eq(1), { $eq: 1 });
  });
});

describe('ping 与门面选择', () => {
  test('ping returns boolean from SELECT 1', async () => {
    const ok = await ping({ pool: { async query() { return { rows: [{ ok: 1 }] }; } } });
    assert.equal(ok, true);
  });

  test('db facade picks mongo by default and postgres with DB_DRIVER', () => {
    delete require.cache[require.resolve('../src/db/index')];
    delete require.cache[require.resolve('../src/config/env')];
    const saved = process.env.DB_DRIVER;
    delete process.env.DB_DRIVER;
    const mongoBackend = require('../src/db/index');
    assert.equal(mongoBackend.getDb, require('../src/db/mongo').getDb);
    process.env.DB_DRIVER = 'postgres';
    delete require.cache[require.resolve('../src/db/index')];
    delete require.cache[require.resolve('../src/config/env')];
    const pgBackend = require('../src/db/index');
    assert.equal(pgBackend.getPool, require('../src/db/postgres').getPool);
    if (saved === undefined) delete process.env.DB_DRIVER; else process.env.DB_DRIVER = saved;
    delete require.cache[require.resolve('../src/db/index')];
    delete require.cache[require.resolve('../src/config/env')];
  });
});
