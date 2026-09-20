'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildWhere } = require('../src/db/pg-filter');

describe('buildWhere — 等值匹配', () => {
  test('empty filter yields TRUE with no params', () => {
    assert.deepEqual(buildWhere({}), { sql: 'TRUE', params: [] });
    assert.deepEqual(buildWhere(null), { sql: 'TRUE', params: [] });
  });

  test('single string equality', () => {
    const { sql, params } = buildWhere({ subject_id: 'anon:abc' });
    assert.equal(sql, "data->'subject_id' = $1::jsonb");
    assert.deepEqual(params, ['"anon:abc"']);
  });

  test('multiple conditions joined by AND', () => {
    const { sql, params } = buildWhere({ subject_id: 'u1', module: 'aiCheer' });
    assert.equal(sql, "data->'subject_id' = $1::jsonb AND data->'module' = $2::jsonb");
    assert.deepEqual(params, ['"u1"', '"aiCheer"']);
  });

  test('number / object / null values serialize as jsonb', () => {
    const a = buildWhere({ count: 5 });
    assert.deepEqual(a.params, ['5']);
    const b = buildWhere({ meta: { k: 1 } });
    assert.equal(b.sql, "data->'meta' = $1::jsonb");
    assert.deepEqual(b.params, ['{"k":1}']);
    const c = buildWhere({ x: null });
    assert.deepEqual(c.params, ['null']);
  });
});

describe('buildWhere — 比较与专用操作符', () => {
  test('$gte / $lte produce parenthesized comparison with cast', () => {
    const { sql, params } = buildWhere({ created_at: { $gte: '2026-09-01T00:00:00Z' } });
    assert.equal(sql, "(data->'created_at') >= $1::jsonb");
    assert.deepEqual(params, ['"2026-09-01T00:00:00Z"']);
  });

  test('$lt / $gt supported', () => {
    const { sql } = buildWhere({ timestamp: { $lt: 100 } });
    assert.equal(sql, "(data->'timestamp') < $1::jsonb");
  });

  test('$eq explicit operator equals plain equality', () => {
    const { sql } = buildWhere({ status: { $eq: 'active' } });
    assert.equal(sql, "data->'status' = $1::jsonb");
  });

  test('$ne uses IS DISTINCT FROM（缺失字段也算不等，对齐 Mongo $ne 语义）', () => {
    const { sql, params } = buildWhere({ status: { $ne: 'under_review' } });
    assert.equal(sql, "data->'status' IS DISTINCT FROM $1::jsonb");
    assert.deepEqual(params, ['"under_review"']);
  });

  test('$exists true/false use jsonb key-existence', () => {
    assert.equal(buildWhere({ event_hit: { $exists: true } }).sql, 'data ? $1');
    assert.deepEqual(buildWhere({ event_hit: { $exists: true } }).params, ['event_hit']);
    assert.equal(buildWhere({ event_hit: { $exists: false } }).sql, 'NOT data ? $1');
  });

  test('$in translates to ANY with jsonb array cast', () => {
    const { sql, params } = buildWhere({ status: { $in: ['a', 'b'] } });
    assert.equal(sql, "data->'status' = ANY($1::jsonb[])");
    assert.deepEqual(params, ['["a","b"]']);
  });

  test('mixed plain and operator conditions share one param sequence', () => {
    const { sql, params } = buildWhere({
      module: 'aiCheer',
      created_at: { $gte: '2026-09-01' },
      event_hit: { $exists: true },
    });
    assert.equal(
      sql,
      "data->'module' = $1::jsonb AND (data->'created_at') >= $2::jsonb AND data ? $3"
    );
    assert.deepEqual(params, ['"aiCheer"', '"2026-09-01"', 'event_hit']);
  });
});

describe('buildWhere — 防御', () => {
  test('rejects illegal field names', () => {
    assert.throws(() => buildWhere({ "x'); DROP TABLE t; --": 1 }), /非法字段名/);
    assert.throws(() => buildWhere({ 123: 1 }), /非法字段名/);
  });

  test('rejects unsupported operators', () => {
    assert.throws(() => buildWhere({ x: { $regex: 'a' } }), /不支持的操作符 \$regex/);
  });

  test('$in requires an array', () => {
    assert.throws(() => buildWhere({ x: { $in: 'ab' } }), /\$in 需要数组/);
  });

  test('custom column name is honored', () => {
    const { sql } = buildWhere({ a: 1 }, 'payload');
    assert.equal(sql, "payload->'a' = $1::jsonb");
  });
});
