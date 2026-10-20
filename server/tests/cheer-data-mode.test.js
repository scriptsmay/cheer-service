'use strict';

// 缺赛期数据模式：验证 cheer.js 的 buildGroundedSource / buildSystemPrompt 三档分支
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../src/routes/cheer');
const {
  buildGroundedSource,
  buildSystemPrompt,
  inspectGeneratedOutput,
  mapStreamErrorCode,
  createStreamRequestObserver,
  createRouteDeadline,
} = __test;

// 模拟一份 season_summaries 文档：既有当前赛季 season_stats，也有生涯 career_summary
const ABILITIES = {
  season: 'KPL2026S2',
  player_name: 'KSG.无言',
  team_name: 'KSG',
  position: '对抗路',
  overall_rating: 93.7,
  overall_rank: 1,
  position_rank: 1,
  dimensions: {
    support_ability: { score: 97, overall_rank: 11, position_rank: 1 },
    tankiness: { score: 97, overall_rank: 13, position_rank: 5 },
    mid_game: { score: 95, overall_rank: 7, position_rank: 4 },
    initiation: { score: 94, overall_rank: 13, position_rank: 1 },
    early_game: { score: 88, overall_rank: 8, position_rank: 1 },
    map_control: { score: 90, overall_rank: 3, position_rank: 1 },
  },
};

const OVERVIEW = {
  season: 'KPL2026S2',
  updated_at: '2026-08-01T00:00:00.000Z',
  abilities: ABILITIES,
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

  test('season 模式注入 abilities 综合评分与分榜第1分项', () => {
    const source = buildGroundedSource(OVERVIEW, 'season');
    assert.deepStrictEqual(source.refs.slice(0, 2), [
      { label: '联盟综合评分', value: '93.7（全联盟第1，对抗路第1）', source: 'season_summaries' },
      { label: '对抗路分榜第1能力', value: '支援97、开团94、地图控制90、前期88', source: 'season_summaries' },
    ]);
    assert.ok(source.promptLines[0].startsWith('联盟综合评分：93.7'), 'abilities 应排在最前');
  });

  test('career / emotion 模式不注入 abilities', () => {
    for (const mode of ['career', 'emotion']) {
      const source = buildGroundedSource(OVERVIEW, mode);
      const labels = source.refs.map((r) => r.label);
      assert.ok(!labels.includes('联盟综合评分'), `${mode} 不应引用综合评分`);
      assert.ok(!labels.includes('对抗路分榜第1能力'), `${mode} 不应引用分榜能力`);
      assert.strictEqual(source.abilitiesDisplay, null, `${mode} 不应输出展示数据`);
    }
  });

  test('abilities 赛季与 overview 不一致时不注入', () => {
    const stale = { ...OVERVIEW, abilities: { ...ABILITIES, season: 'KPL2026S1' } };
    const source = buildGroundedSource(stale, 'season');
    assert.ok(!source.refs.map((r) => r.label).includes('联盟综合评分'));
    assert.strictEqual(source.abilitiesDisplay, null);
  });

  test('season 模式生成紧凑展示数据：总分/排名 + 前3字段', () => {
    const display = buildGroundedSource(OVERVIEW, 'season').abilitiesDisplay;
    assert.deepStrictEqual(display, {
      score: 93.7,
      overall_rank: 1,
      position: '对抗路',
      position_rank: 1,
      fields: [
        { key: 'support_ability', label: '支援能力', score: 97, rank: 1 },
        { key: 'initiation', label: '开团能力', score: 94, rank: 1 },
        { key: 'map_control', label: '场景控制', score: 90, rank: 1 },
        { key: 'early_game', label: '前期表现', score: 88, rank: 1 },
      ],
    });
    const keys = display.fields.map((field) => field.key);
    assert.ok(!keys.includes('tankiness'), '承伤第5不应展示');
    assert.ok(!keys.includes('mid_game'), '中期第4不应展示');
  });

  test('prompt 放行排名表述并保留可引用数据', () => {
    const source = buildGroundedSource(OVERVIEW, 'season');
    const prompt = buildSystemPrompt('daily', source, 'season', {});
    assert.ok(prompt.includes('可引用数据：联盟综合评分：93.7（全联盟第1，对抗路第1）'));
    assert.ok(prompt.includes('对抗路分榜第1不能说成全联盟第1'), '应含排名口径约束');
  });

  test('校验层放行 93.7 / 第1，拒绝编造评分', () => {
    const source = buildGroundedSource(OVERVIEW, 'season');
    const opts = { line_count: 2, humanize: false };
    const ok = inspectGeneratedOutput({
      lines: [
        '联盟综合评分93.7全联盟第1，这场对抗路的含金量还在涨。',
        '对抗路分榜第1的支援97，团战里总能把节奏接住。',
      ],
      emoji_caption: '继续冲',
    }, source, opts);
    assert.strictEqual(ok.ok, true);

    const bad = inspectGeneratedOutput({
      lines: [
        '联盟综合评分95.2全联盟第1，这场对抗路的含金量还在涨。',
        '对抗路分榜第1的支援97，团战里总能把节奏接住。',
      ],
      emoji_caption: '继续冲',
    }, source, opts);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'ungrounded_number');
  });
});

describe('stream observability', () => {
  test('route deadline helper 在绝对时间到达时终止挂起等待', async () => {
    const deadline = createRouteDeadline(Date.now() + 20);
    try {
      await assert.rejects(
        deadline.run(() => new Promise(() => {})),
        (error) => error.code === 'AI_STREAM_TOTAL_TIMEOUT'
      );
      assert.equal(deadline.expired(), true);
    } finally {
      deadline.dispose();
    }
  });

  test('服务内部超时错误映射为对应 SSE 错误码', () => {
    assert.equal(mapStreamErrorCode({ code: 'AI_STREAM_TOTAL_TIMEOUT' }), 'GENERATION_TIMEOUT');
    assert.equal(mapStreamErrorCode({ code: 'AI_STREAM_IDLE_TIMEOUT' }), 'AI_STREAM_IDLE_TIMEOUT');
    assert.equal(mapStreamErrorCode({ code: 'UPSTREAM_FAILED' }), 'WRITE_FAILED');
  });

  test('重试摘要累计所有尝试 usage，model 取最近一次实际模型', () => {
    const observer = createStreamRequestObserver('req-retry', 1000, () => 5000);
    observer.recordStreamResult({ model: 'model-one', usage: { total_tokens: 10, prompt_tokens: 4, completion_tokens: 6 } });
    observer.recordStreamResult({ model: 'model-two', usage: { total_tokens: 5, completion_tokens: 3 } });

    const originalInfo = console.info;
    console.info = () => {};
    let summary;
    try {
      summary = observer.finalize();
    } finally {
      console.info = originalInfo;
    }

    assert.equal(summary.model, 'model-two');
    assert.deepEqual(summary.usage, {
      total_tokens: 15,
      prompt_tokens: 4,
      completion_tokens: 9,
    });
  });

  test('请求结束时仅记录一次包含规定字段的摘要', () => {
    let currentTime = 1000;
    const observer = createStreamRequestObserver('req-123', 1000, () => currentTime);
    currentTime = 1500;
    observer.recordUpstreamChunk('reasoning');
    currentTime = 2000;
    observer.recordUpstreamChunk('content');
    observer.recordStreamResult({ model: 'test-model', usage: { total_tokens: 7 } });
    observer.setPhase('generation');
    observer.setTermination('complete');
    observer.setRetryCount(2);
    currentTime = 4000;

    const calls = [];
    const originalInfo = console.info;
    console.info = (...args) => calls.push(args);
    let summary;
    let repeatedSummary;
    try {
      summary = observer.finalize();
      repeatedSummary = observer.finalize();
    } finally {
      console.info = originalInfo;
    }

    assert.deepEqual(summary, {
      request_id: 'req-123',
      elapsed_ms: 3000,
      phase: 'generation',
      termination: 'complete',
      model: 'test-model',
      last_upstream_activity_ms: 2000,
      reasoning_chunks: 1,
      content_chunks: 1,
      retry_count: 2,
      usage: { total_tokens: 7 },
    });
    assert.equal(repeatedSummary, undefined);
    assert.deepEqual(calls, [
      ['[ai-cheer-stream] request summary', summary],
    ]);
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
