'use strict';

/**
 * 打卡辅助函数 — 从 checkin/summary.js 移植
 */

const { hashValue } = require('../utils/helpers');

function makeCheckinId(subjectId, date) {
  return hashValue(`${subjectId}:${date}`);
}

function computeCheckinSummary(records) {
  const dates = [
    ...new Set(
      (Array.isArray(records) ? records : [])
        .map((record) => (record && typeof record.date === 'string' ? record.date : ''))
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))
    ),
  ].sort();
  const lastDate = dates.at(-1) || '';
  let streak = 0;
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const expected = new Date(`${lastDate}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() - (dates.length - 1 - index));
    if (dates[index] !== expected.toISOString().slice(0, 10)) break;
    streak += 1;
  }
  return { last_date: lastDate, streak, total_days: dates.length };
}

module.exports = { makeCheckinId, computeCheckinSummary };
