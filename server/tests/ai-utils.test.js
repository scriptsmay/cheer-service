'use strict';

// Set env vars before requiring modules
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '赌博,色情,自杀,暴力,恐怖,毒品,诈骗,传销,政治敏感,反动,违法,违规';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { isContentBlocked, fmtRate } = require('../src/lib/ai-utils');

describe('isContentBlocked', () => {
  test('returns false for normal text', () => {
    assert.strictEqual(isContentBlocked('无言加油！'), false);
  });

  test('returns false for empty/null', () => {
    assert.strictEqual(isContentBlocked(''), false);
    assert.strictEqual(isContentBlocked(null), false);
    assert.strictEqual(isContentBlocked(undefined), false);
  });

  test('blocks terms from config', () => {
    assert.strictEqual(isContentBlocked('这里有赌博内容'), true);
    assert.strictEqual(isContentBlocked('涉及色情'), true);
  });

  test('blocks default patterns', () => {
    assert.strictEqual(isContentBlocked('不要自杀'), true);
    assert.strictEqual(isContentBlocked('博彩网站'), true);
  });
});

describe('fmtRate', () => {
  test('converts decimal to percentage', () => {
    assert.strictEqual(fmtRate(0.65), '65.0%');
  });

  test('passes through percentage strings', () => {
    assert.strictEqual(fmtRate('80%'), '80%');
  });

  test('converts string decimal', () => {
    assert.strictEqual(fmtRate('0.5'), '50.0%');
  });

  test('returns 暂无 for null/undefined', () => {
    assert.strictEqual(fmtRate(null), '暂无');
    assert.strictEqual(fmtRate(undefined), '暂无');
  });
});
