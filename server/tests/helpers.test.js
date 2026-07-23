'use strict';

// Set env vars before requiring modules
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '赌博,色情,自杀,暴力,恐怖,毒品,诈骗,传销,政治敏感,反动,违法,违规';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  hashValue,
  shanghaiDate,
  normalizeClientId,
  isValidClientId,
  normalizeRequestId,
  formatRate,
  textLength,
  isObject,
  getErrorMessage,
  positiveInt,
} = require('../src/utils/helpers');

describe('hashValue', () => {
  test('returns a 64-char hex string', () => {
    const result = hashValue('test');
    assert.match(result, /^[0-9a-f]{64}$/);
  });

  test('produces different output with different salt', () => {
    assert.notEqual(hashValue('test'), hashValue('test', 'salt'));
  });

  test('is deterministic for same input and salt', () => {
    assert.strictEqual(hashValue('abc', 's'), hashValue('abc', 's'));
  });
});

describe('shanghaiDate', () => {
  test('returns date and yesterday in YYYY-MM-DD format', () => {
    const result = shanghaiDate(new Date('2026-07-23T03:00:00Z'));
    assert.match(result.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(result.yesterday, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('correctly converts UTC to Shanghai time', () => {
    // 2026-07-23T16:00:00Z = 2026-07-24 00:00 Shanghai
    const result = shanghaiDate(new Date('2026-07-23T16:00:00Z'));
    assert.strictEqual(result.date, '2026-07-24');
  });
});

describe('normalizeClientId', () => {
  test('trims and truncates to 80 chars', () => {
    const long = '  '.repeat(5) + 'a'.repeat(100) + '  ';
    const result = normalizeClientId(long);
    assert.strictEqual(result.length, 80);
  });

  test('returns empty string for null/undefined', () => {
    assert.strictEqual(normalizeClientId(null), '');
    assert.strictEqual(normalizeClientId(undefined), '');
  });
});

describe('isValidClientId', () => {
  test('accepts valid alphanumeric with _:- and length 8-80', () => {
    assert.strictEqual(isValidClientId('abc12345-_:'), true);
  });

  test('rejects too short', () => {
    assert.strictEqual(isValidClientId('abc'), false);
  });

  test('rejects special chars', () => {
    assert.strictEqual(isValidClientId('abcde@123'), false);
  });
});

describe('normalizeRequestId', () => {
  test('strips non-alphanumeric chars', () => {
    assert.strictEqual(normalizeRequestId('abc!@#123'), 'abc123');
  });

  test('returns a UUID for empty input', () => {
    const result = normalizeRequestId('');
    assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('formatRate', () => {
  test('converts decimal 0.5 to 50%', () => {
    assert.strictEqual(formatRate(0.5), '50%');
  });

  test('passes through percentage strings', () => {
    assert.strictEqual(formatRate('75%'), '75%');
  });

  test('converts number > 1 as percentage', () => {
    assert.strictEqual(formatRate(75), '75%');
  });

  test('returns empty for null/undefined', () => {
    assert.strictEqual(formatRate(null), '');
    assert.strictEqual(formatRate(undefined), '');
  });
});

describe('textLength', () => {
  test('counts Unicode characters not bytes', () => {
    assert.strictEqual(textLength('你好'), 2);
  });

  test('returns 0 for null/undefined', () => {
    assert.strictEqual(textLength(null), 0);
  });
});

describe('isObject', () => {
  test('true for plain objects', () => {
    assert.strictEqual(isObject({}), true);
  });

  test('false for arrays', () => {
    assert.strictEqual(isObject([]), false);
  });

  test('false for null/undefined', () => {
    assert.strictEqual(isObject(null), false);
    assert.strictEqual(isObject(undefined), false);
  });
});

describe('getErrorMessage', () => {
  test('extracts message from Error', () => {
    assert.strictEqual(getErrorMessage(new Error('boom')), 'boom');
  });

  test('stringifies non-Error', () => {
    assert.strictEqual(getErrorMessage('oops'), 'oops');
  });
});

describe('positiveInt', () => {
  test('returns valid positive integer', () => {
    assert.strictEqual(positiveInt(5, 10), 5);
  });

  test('returns fallback for non-integer', () => {
    assert.strictEqual(positiveInt(3.5, 10), 10);
  });

  test('returns fallback for zero/negative', () => {
    assert.strictEqual(positiveInt(0, 10), 10);
    assert.strictEqual(positiveInt(-1, 10), 10);
  });
});
