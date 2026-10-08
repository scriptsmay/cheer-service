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
  getTimeSlot,
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
    assert.strictEqual(result.hour, 0);
    assert.strictEqual(result.timeSlot.slot, 'night');
  });
});

describe('getTimeSlot', () => {
  test('07:00 identifies as morning slot with commuter prompt hint', () => {
    // 2026-10-08T07:00:00+08:00 = 2026-10-07T23:00:00Z
    const slot = getTimeSlot(new Date('2026-10-07T23:00:00Z'));
    assert.strictEqual(slot.hour, 7);
    assert.strictEqual(slot.slot, 'morning');
    assert.strictEqual(slot.slotLabel, '早晨/上午');
    assert.match(slot.promptHint, /上班\/上学通勤/);
    assert.match(slot.promptHint, /严禁写"下班"/);
  });

  test('13:30 identifies as afternoon slot', () => {
    // 2026-10-08T13:30:00+08:00 = 2026-10-08T05:30:00Z
    const slot = getTimeSlot(new Date('2026-10-08T05:30:00Z'));
    assert.strictEqual(slot.hour, 13);
    assert.strictEqual(slot.slot, 'afternoon');
    assert.strictEqual(slot.slotLabel, '午间/下午');
    assert.match(slot.promptHint, /午休摸鱼/);
  });

  test('19:15 identifies as evening slot', () => {
    // 2026-10-08T19:15:00+08:00 = 2026-10-08T11:15:00Z
    const slot = getTimeSlot(new Date('2026-10-08T11:15:00Z'));
    assert.strictEqual(slot.hour, 19);
    assert.strictEqual(slot.slot, 'evening');
    assert.strictEqual(slot.slotLabel, '傍晚/晚间');
    assert.match(slot.promptHint, /下班路上/);
  });

  test('02:00 identifies as night slot', () => {
    // 2026-10-08T02:00:00+08:00 = 2026-10-07T18:00:00Z
    const slot = getTimeSlot(new Date('2026-10-07T18:00:00Z'));
    assert.strictEqual(slot.hour, 2);
    assert.strictEqual(slot.slot, 'night');
    assert.strictEqual(slot.slotLabel, '深夜/凌晨');
    assert.match(slot.promptHint, /夜猫子/);
  });

  test('boundary hour transitions (05:59->night, 06:00->morning, 11:59->morning, 12:00->afternoon, 17:59->afternoon, 18:00->evening, 23:59->evening, 00:00->night)', () => {
    assert.strictEqual(getTimeSlot(new Date('2026-10-07T21:59:00Z')).slot, 'night');     // 05:59 BJ
    assert.strictEqual(getTimeSlot(new Date('2026-10-07T22:00:00Z')).slot, 'morning');   // 06:00 BJ
    assert.strictEqual(getTimeSlot(new Date('2026-10-08T03:59:00Z')).slot, 'morning');   // 11:59 BJ
    assert.strictEqual(getTimeSlot(new Date('2026-10-08T04:00:00Z')).slot, 'afternoon'); // 12:00 BJ
    assert.strictEqual(getTimeSlot(new Date('2026-10-08T09:59:00Z')).slot, 'afternoon'); // 17:59 BJ
    assert.strictEqual(getTimeSlot(new Date('2026-10-08T10:00:00Z')).slot, 'evening');   // 18:00 BJ
    assert.strictEqual(getTimeSlot(new Date('2026-10-08T15:59:00Z')).slot, 'evening');   // 23:59 BJ
    assert.strictEqual(getTimeSlot(new Date('2026-10-08T16:00:00Z')).slot, 'night');     // 00:00 BJ
  });

  test('defensive parsing with string, timestamp, null, undefined, invalid date', () => {
    const fromStr = getTimeSlot('2026-10-08T07:15:00+08:00');
    assert.strictEqual(fromStr.hour, 7);
    assert.strictEqual(fromStr.slot, 'morning');

    const fromTs = getTimeSlot(new Date('2026-10-08T19:00:00+08:00').getTime());
    assert.strictEqual(fromTs.hour, 19);
    assert.strictEqual(fromTs.slot, 'evening');

    assert.ok(getTimeSlot(null).slot);
    assert.ok(getTimeSlot(undefined).slot);
    assert.ok(getTimeSlot('invalid-date-string').slot);
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
