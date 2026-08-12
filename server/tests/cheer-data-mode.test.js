'use strict';

// 缺赛期数据模式：验证 cheer.js 的 buildGroundedSource / buildSystemPrompt 三档分支
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../src/routes/cheer');
const { buildGroundedSource, buildSystemPrompt } = __test;

// 模拟一份 season_summaries 文档：既有当前赛季 season_stats，也有生涯 career_summary
const OVERVIEW = {
  season: 'KPL2026S2',
  updated_at: '2026-08-01T00:00:00.000Z',
  data: {
    data: {
      season_stats: [
        { season_id: 'KPL2026S2', kda_ratio: 4.29, win_rate: 0.567, battles: 28, mvp: 5, avg_assists: 6.1 },
      ],
      career_summary: { kda_ratio: 3.8, win_rate: 0.52, total_battles: 300, mvp_count: 40, avg_assists: 5.5 },
      hero_stats: [
        { hero_name: '关羽', battles: 15, win_rate: 0.6 },
        { hero_name: '夏侯惇', battles: 8, win_rate: 0.5 },
      ],
    },
  },
};

describe('buildGroundedSource — 数据模式分支', () => {
  test('season 模式注入当前赛季数据', () => {
    const source = buildGroundedSource(OVERVIEW, 'season');
    const labels = source.refs.map((r) => r.label);
    assert.ok(labels.includes('当前赛季 KDA'), '应包含当前赛季 KDA');
    const kda = source.refs.find((r) => r.label === '当前赛季 KDA');
    assert.strictEqual(kda.value, '4.29');
  });

  test('career 模式强制走生涯口径，忽略当前赛季', () => {
    const source = buildGroundedSource(OVERVIEW, 'career');
    const labels = source.refs.map((r) => r.label);
    assert.ok(labels.includes('生涯 KDA'), '应包含生涯 KDA');
    assert.ok(!labels.some((l) => l.startsWith('当前赛季')), '不应出现"当前赛季"标签');
    const kda = source.refs.find((r) => r.label === '生涯 KDA');
    assert.strictEqual(kda.value, '3.8');
    // hero_stats 是赛季维度数据，标签不应被冠以"生涯"以免数据与标签不匹配
    assert.ok(labels.includes('常用英雄（按出场数）'), '英雄标签保持中性口径');
  });

  test('emotion 模式不注入任何数据', () => {
    const source = buildGroundedSource(OVERVIEW, 'emotion');
    assert.strictEqual(source.refs.length, 0);
    assert.strictEqual(source.promptLines.length, 0);
  });

  test('无 overview 时退化为空数据', () => {
    const source = buildGroundedSource(null, 'season');
    assert.strictEqual(source.refs.length, 0);
  });
});

describe('buildSystemPrompt — 缺赛期约束', () => {
  test('season 模式不含缺赛期约束', () => {
    const source = buildGroundedSource(OVERVIEW, 'season');
    const prompt = buildSystemPrompt('daily', source, 'season');
    assert.ok(!prompt.includes('缺赛期'), 'season 模式不应含缺赛期约束');
  });

  test('career 模式含缺赛期约束并替换 hope 语气', () => {
    const source = buildGroundedSource(OVERVIEW, 'career');
    const prompt = buildSystemPrompt('hope', source, 'career');
    assert.ok(prompt.includes('缺赛期'), 'career 模式应含缺赛期约束');
    assert.ok(prompt.includes('禁止使用"下一场"'), '缺赛期约束条款应完整保留');
    assert.ok(!prompt.includes('给下一场蓄力'), 'hope 语气不应保留"下一场"前瞻表述');
    assert.ok(prompt.includes('长期陪伴与信任'), '缺赛期 hope 变体应替换为长期陪伴口径');
  });

  test('emotion 模式含缺赛期约束且提示纯情绪', () => {
    const source = buildGroundedSource(OVERVIEW, 'emotion');
    const prompt = buildSystemPrompt('daily', source, 'emotion');
    assert.ok(prompt.includes('缺赛期'), 'emotion 模式应含缺赛期约束');
    assert.ok(prompt.includes('纯情绪应援文案'), '无数据时应提示纯情绪');
  });
});
