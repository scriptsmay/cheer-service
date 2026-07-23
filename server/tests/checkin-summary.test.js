'use strict';

// Set env vars before requiring modules
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '赌博,色情,自杀,暴力,恐怖,毒品,诈骗,传销,政治敏感,反动,违法,违规';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { makeCheckinId, computeCheckinSummary } = require('../src/utils/checkin-summary');

describe('makeCheckinId', () => {
  test('returns a deterministic hex string', () => {
    const id = makeCheckinId('user1', '2026-07-23');
    assert.match(id, /^[0-9a-f]{64}$/);
  });

  test('different inputs produce different ids', () => {
    assert.notEqual(
      makeCheckinId('user1', '2026-07-23'),
      makeCheckinId('user2', '2026-07-23')
    );
  });
});

describe('computeCheckinSummary', () => {
  test('returns zero streak for empty records', () => {
    const result = computeCheckinSummary([]);
    assert.strictEqual(result.streak, 0);
    assert.strictEqual(result.total_days, 0);
    assert.strictEqual(result.last_date, '');
  });

  test('computes streak for consecutive days', () => {
    const records = [
      { date: '2026-07-21' },
      { date: '2026-07-22' },
      { date: '2026-07-23' },
    ];
    const result = computeCheckinSummary(records);
    assert.strictEqual(result.streak, 3);
    assert.strictEqual(result.total_days, 3);
    assert.strictEqual(result.last_date, '2026-07-23');
  });

  test('breaks streak on gap', () => {
    const records = [
      { date: '2026-07-20' },
      { date: '2026-07-21' },
      { date: '2026-07-23' }, // gap on 22nd
    ];
    const result = computeCheckinSummary(records);
    assert.strictEqual(result.streak, 1);
    assert.strictEqual(result.total_days, 3);
  });

  test('deduplicates dates', () => {
    const records = [
      { date: '2026-07-23' },
      { date: '2026-07-23' },
    ];
    const result = computeCheckinSummary(records);
    assert.strictEqual(result.total_days, 1);
    assert.strictEqual(result.streak, 1);
  });

  test('ignores invalid date formats', () => {
    const records = [
      { date: 'invalid' },
      { date: '2026-07-23' },
    ];
    const result = computeCheckinSummary(records);
    assert.strictEqual(result.total_days, 1);
  });

  test('handles null records gracefully', () => {
    const result = computeCheckinSummary(null);
    assert.strictEqual(result.total_days, 0);
    assert.strictEqual(result.streak, 0);
  });
});
