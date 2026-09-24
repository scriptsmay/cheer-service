'use strict';

/**
 * 文案多样性改造测试（方案文档：cheer-copy-diversification-plan.md）
 *
 * 覆盖四层：
 *  1. date-context 纯函数：节气/节日锚点、事件三档档位边界矩阵、模板避重
 *  2. buildSystemPrompt：亚运豁免正向替换 / 反 AI 味指南开关 / 今日背景注入
 *  3. checkAiFlavor + inspectGeneratedOutput：5 条反 AI 味量化规则 + 可关
 *  4. settings-store 事件表 CRUD：幂等 upsert、窗口过滤、配置合并（内存 mock DB）
 */

process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const dc = require('../src/lib/date-context');
const { __test } = require('../src/routes/cheer');
const {
  CHEER_LINE_COUNT, CHEER_LINE_MIN_CHARS, buildGroundedSource, buildSystemPrompt,
  inspectGeneratedOutput, checkAiFlavor, collectAnchorNumbers, buildRetryInstruction,
} = __test;

// 复刻 cheer-data-mode.test.js 的赛季文档，供 buildGroundedSource 使用
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

// ── 事件样例（与 admin 面板默认配置一致）──
const EVENT_ASIAN_GAMES = { date: '2026-09-28', title: '亚运会王者荣耀金牌赛', leadDays: 30, type: 'gold_medal' };

// ════════════════════════════════════════════════════════════════
// 1. date-context：事件档位边界矩阵
// ════════════════════════════════════════════════════════════════

describe('resolveEventPhase — 事件档位边界矩阵', () => {
  test('窗口外 / 已过期不命中', () => {
    assert.strictEqual(dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-29'), null, 'T+1 已过期');
    assert.strictEqual(dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-08-28'), null, 'T-31 超出默认 30 天窗口');
  });

  test('预热期仅里程碑日命中（T-30/T-20/T-15/T-10）', () => {
    for (const daysUntil of [30, 20, 15, 10]) {
      const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-08-29');
      const expected = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-28');
      const d = new Date(Date.UTC(2026, 8, 28));
      d.setUTCDate(d.getUTCDate() - daysUntil);
      const dateStr = d.toISOString().slice(0, 10);
      const result = dc.resolveEventPhase(EVENT_ASIAN_GAMES, dateStr);
      assert.ok(result, `T-${daysUntil} 应为 preview（日期 ${dateStr}）`);
      assert.strictEqual(result.phase, 'preview');
      assert.strictEqual(result.daysUntil, daysUntil);
      assert.strictEqual(result.milestone, true);
      void expected;
    }
  });

  test('预热期非里程碑日命中 preview 且 milestone:false（v1.1.0 全窗口可见）', () => {
    // T-29/28/27（预热前段）与 T-9/8（预热后段，旧版在此返回 null）
    for (const [dateStr, daysUntil] of [
      ['2026-08-30', 29], ['2026-08-31', 28], ['2026-09-01', 27], ['2026-09-19', 9], ['2026-09-20', 8],
    ]) {
      const result = dc.resolveEventPhase(EVENT_ASIAN_GAMES, dateStr);
      assert.ok(result, `T-${daysUntil} 应命中 preview（日期 ${dateStr}）`);
      assert.strictEqual(result.phase, 'preview');
      assert.strictEqual(result.daysUntil, daysUntil);
      assert.strictEqual(result.milestone, false, `T-${daysUntil} 非里程碑日，milestone 应为 false`);
    }
  });

  test('T-7 边界：预热与倒数分界（T-8 preview / T-7 countdown）', () => {
    assert.strictEqual(dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-20')?.phase, 'preview', 'T-8 属预热期');
    const t7 = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-21');
    assert.strictEqual(t7.phase, 'countdown', 'T-7 起进入倒数档');
    assert.strictEqual(t7.milestone, true);
  });

  test('倒数期每天命中（T-7 ~ T-2）', () => {
    for (const daysUntil of [7, 6, 5, 4, 3, 2]) {
      const d = new Date(Date.UTC(2026, 8, 28));
      d.setUTCDate(d.getUTCDate() - daysUntil);
      const result = dc.resolveEventPhase(EVENT_ASIAN_GAMES, d.toISOString().slice(0, 10));
      assert.ok(result, `T-${daysUntil} 应命中 countdown`);
      assert.strictEqual(result.phase, 'countdown');
    }
  });

  test('临场 eve 与当天 today', () => {
    const eve = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-27');
    assert.deepStrictEqual(eve, { phase: 'eve', daysUntil: 1, milestone: true });
    const today = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-28');
    assert.deepStrictEqual(today, { phase: 'today', daysUntil: 0, milestone: true });
  });

  test('leadDays:0 仅当天命中', () => {
    const ev0 = { date: '2026-09-28', title: 'X', leadDays: 0 };
    assert.strictEqual(dc.resolveEventPhase(ev0, '2026-09-27'), null, 'T-1 不命中');
    assert.strictEqual(dc.resolveEventPhase(ev0, '2026-09-28')?.phase, 'today');
    assert.strictEqual(dc.resolveEventPhase(ev0, '2026-09-29'), null, 'T+1 不命中');
  });

  test('自定义 leadDays（5 天）边界：小窗口无预热期，直接进倒数', () => {
    const ev5 = { date: '2026-09-28', title: 'X', leadDays: 5 };
    assert.strictEqual(dc.resolveEventPhase(ev5, '2026-09-22'), null, 'T-6 超窗');
    // daysUntil=5 <= 7，T-5 落入倒数分支（窗口 ≤7 天的事件没有预热里程碑）
    assert.strictEqual(dc.resolveEventPhase(ev5, '2026-09-23')?.phase, 'countdown', 'T-5 直接倒数');
    assert.strictEqual(dc.resolveEventPhase(ev5, '2026-09-25')?.phase, 'countdown', 'T-3 倒数');
  });

  test('非法日期 / 非法事件返回 null', () => {
    assert.strictEqual(dc.resolveEventPhase(null, '2026-09-28'), null);
    assert.strictEqual(dc.resolveEventPhase({}, '2026-09-28'), null);
    assert.strictEqual(dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026/09/28'), null, '非 YYYY-MM-DD 格式');
  });
});

// ════════════════════════════════════════════════════════════════
// 2. date-context：锚点（节气 / 节日 / 事件）与模板避重
// ════════════════════════════════════════════════════════════════

describe('getDateContext — 时间锚点注入', () => {
  test('无锚点日期返回 null（不注入时间段）', () => {
    assert.strictEqual(dc.getDateContext('2026-08-29', null, null), null);
    assert.strictEqual(dc.getDateContext('2026-08-28', null, null), null);
  });

  test('节气当天注入', () => {
    const ctx = dc.getDateContext('2026-08-07', null, null); // 立秋
    assert.ok(ctx.anchors.some((a) => a.kind === 'jieqi' && a.text === '今天是立秋'));
  });

  test('节气临近 ±3 天注入（前 3 天预告 / 后 3 天余韵）', () => {
    const before = dc.getDateContext('2026-08-04', null, null);
    assert.ok(before.anchors.some((a) => a.text === '距离立秋还有 3 天'));
    const after = dc.getDateContext('2026-08-10', null, null);
    assert.ok(after.anchors.some((a) => a.text === '立秋刚过'));
  });

  test('农历传统节日注入（中秋 2026-09-25）', () => {
    const ctx = dc.getDateContext('2026-09-25', null, null);
    assert.ok(ctx.anchors.some((a) => a.kind === 'festival' && a.text === '今天是中秋节'));
  });

  test('公历节日走白名单（国庆节注入）', () => {
    const ctx = dc.getDateContext('2026-10-01', null, null);
    assert.ok(ctx.anchors.some((a) => a.text === '今天是国庆节'));
  });

  test('冷门公历节日被白名单过滤（9/18 无"全民国防教育日"）', () => {
    const ctx = dc.getDateContext('2026-09-18', null, null);
    const texts = ctx.anchors.map((a) => a.text);
    assert.ok(!texts.some((t) => t.includes('国防教育')), '不应注入冷门公历节日');
    assert.ok(texts.some((t) => t.includes('中秋节')), '农历节日不受影响');
  });

  test('节日前瞻 7 天注入（9/18 有"距离中秋节还有 7 天"）', () => {
    const ctx = dc.getDateContext('2026-09-18', null, null);
    assert.ok(ctx.anchors.some((a) => a.text === '距离中秋节还有 7 天'));
  });

  test('dateLabel 格式（无前导零 + 中文星期）', () => {
    const ctx = dc.getDateContext('2026-09-28', null, null);
    assert.strictEqual(ctx.dateLabel, '9月28日 星期一');
  });

  test('预热非里程碑日事件锚点注入（v1.1.0：T-26 也有赛事锚点，含倒数天数）', () => {
    const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-02');
    assert.strictEqual(phase.phase, 'preview');
    assert.strictEqual(phase.milestone, false);
    const ctx = dc.getDateContext('2026-09-02', phase, EVENT_ASIAN_GAMES);
    const eventAnchor = ctx.anchors.find((a) => a.kind === 'event');
    assert.ok(eventAnchor, '预热日应注入 event 锚点');
    assert.ok(eventAnchor.text.includes('26'), `锚点文案应含倒数天数 26，实际：${eventAnchor.text}`);
  });

  test('事件命中时注入 event 锚点', () => {
    const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-28');
    const ctx = dc.getDateContext('2026-09-28', phase, EVENT_ASIAN_GAMES);
    const eventAnchor = ctx.anchors.find((a) => a.kind === 'event');
    assert.ok(eventAnchor, '应包含 event 锚点');
    assert.ok(eventAnchor.text.includes('亚运会王者荣耀金牌赛'));
  });

  test('锚点去重（同日多节日不重复）', () => {
    const ctx = dc.getDateContext('2026-09-25', null, null); // 中秋 + 秋分刚过 + 国庆前瞻
    const texts = ctx.anchors.map((a) => a.text);
    assert.strictEqual(new Set(texts).size, texts.length, '锚点文本不应重复');
  });
});

describe('buildEventText — 赛事文案模板', () => {
  test('日期去前导零', () => {
    const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-28');
    const text = dc.buildEventText(phase, EVENT_ASIAN_GAMES);
    assert.ok(!text.includes('2026年09月28日'), '不应保留前导零');
    assert.ok(text.includes('9月28日') || text.includes('今天'), '应为自然日期表达');
  });

  test('avoidText 避重：同一档位换模板', () => {
    const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-28');
    const first = dc.buildEventText(phase, EVENT_ASIAN_GAMES);
    // 反复尝试应能选出与 first 不同的模板（模板库 ≥2 条）
    let different = null;
    for (let i = 0; i < 20 && !different; i += 1) {
      const t = dc.buildEventText(phase, EVENT_ASIAN_GAMES, first);
      if (t !== first) different = t;
    }
    assert.ok(different, '应能选出不同模板');
  });
});

// ════════════════════════════════════════════════════════════════
// 3. buildSystemPrompt：亚运豁免 / humanize 开关 / 今日背景
// ════════════════════════════════════════════════════════════════

describe('buildSystemPrompt — 多样性上下文注入', () => {
  const sourceCareer = buildGroundedSource(OVERVIEW, 'career');

  test('career + 事件命中 → 亚运豁免版约束（放行亚运表述）', () => {
    const prompt = buildSystemPrompt('daily', sourceCareer, 'career', { eventHit: { _id: 'e1' } });
    assert.ok(prompt.includes('国家赛事'), '应包含亚运豁免语');
    assert.ok(prompt.includes('亚运'), '应允许亚运应援表述');
    assert.ok(prompt.includes('禁止使用"下一场"'), 'KPL 禁令应保留');
    assert.ok(!prompt.includes('不要写成天气预报'), '无 dateContext 时不应有今日背景提示');
  });

  test('career 无事件 → 普通缺赛期约束（不含亚运豁免）', () => {
    const prompt = buildSystemPrompt('daily', sourceCareer, 'career', {});
    assert.ok(prompt.includes('缺赛期'), '应含缺赛期约束');
    assert.ok(!prompt.includes('国家赛事'), '无事件时不应注入亚运豁免');
  });

  test('season 模式（非缺赛期）不注入缺赛期约束', () => {
    const sourceSeason = buildGroundedSource(OVERVIEW, 'season');
    const prompt = buildSystemPrompt('daily', sourceSeason, 'season', {});
    assert.ok(!prompt.includes('缺赛期'));
  });

  test('humanize 默认开启（含反 AI 味指南），显式关闭则不含', () => {
    const on = buildSystemPrompt('daily', sourceCareer, 'career', {});
    assert.ok(on.includes('避免 AI 腔'), '默认应开启 humanize');
    const off = buildSystemPrompt('daily', sourceCareer, 'career', { humanizeEnabled: false });
    assert.ok(!off.includes('避免 AI 腔'), 'humanizeEnabled:false 应移除指南');
  });

  test('dateContext 命中时注入"今日背景"段', () => {
    const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, '2026-09-28');
    const dateContext = dc.getDateContext('2026-09-28', phase, EVENT_ASIAN_GAMES);
    const prompt = buildSystemPrompt('daily', sourceCareer, 'career', {
      dateContext, eventHit: { _id: 'e1' }, eventPhase: phase,
    });
    assert.ok(prompt.includes('今日背景：9月28日 星期一'), '应注入今日背景');
    assert.ok(prompt.includes('亚运会王者荣耀金牌赛'), '背景应含事件文案');
  });

  test('countdown/eve/today 档：赛事语境必含（强提示），无软提示措辞', () => {
    for (const dateStr of ['2026-09-26', '2026-09-27', '2026-09-28']) {
      const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, dateStr);
      const dateContext = dc.getDateContext(dateStr, phase, EVENT_ASIAN_GAMES);
      const prompt = buildSystemPrompt('daily', sourceCareer, 'career', {
        dateContext, eventHit: { _id: 'e1' }, eventPhase: phase,
      });
      assert.ok(prompt.includes('至少 1 条要自然体现'), `${dateStr}（${phase.phase}）应为必含强提示`);
      assert.ok(!prompt.includes('最多提及一次时间语境'), `${dateStr} 不应保留软提示措辞`);
    }
  });

  test('preview 档（T-30 里程碑 / T-26 非里程碑）：轻提软必含提示，非强必含也非旧软提示', () => {
    for (const dateStr of ['2026-08-29', '2026-09-02']) {
      const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, dateStr);
      assert.strictEqual(phase.phase, 'preview');
      const dateContext = dc.getDateContext(dateStr, phase, EVENT_ASIAN_GAMES);
      const prompt = buildSystemPrompt('daily', sourceCareer, 'career', {
        dateContext, eventHit: { _id: 'e1' }, eventPhase: phase,
      });
      assert.ok(prompt.includes('至少 1 条要轻提赛事'), `${dateStr} 预热档应注入轻提软必含提示`);
      assert.ok(prompt.includes(`不要 ${CHEER_LINE_COUNT} 条全挂倒数`), '应含防过度提及约束');
      assert.ok(!prompt.includes('至少一条要自然体现'), '预热档不应升级为强必含');
      assert.ok(!prompt.includes('最多提及一次时间语境'), '预热档应替换旧通用软提示措辞');
    }
  });

  test('无事件命中（纯节日日）：维持通用时间语境软提示', () => {
    const dateContext = dc.getDateContext('2026-10-01', null, null); // 国庆，事件窗口外
    assert.ok(dateContext, '国庆日应有锚点');
    const prompt = buildSystemPrompt('daily', sourceCareer, 'career', { dateContext });
    assert.ok(prompt.includes('最多提及一次时间语境'), '无事件日应用通用软提示');
    assert.ok(!prompt.includes('轻提赛事'), '不应出现预热提示');
    assert.ok(!prompt.includes('至少一条要自然体现'), '不应出现强必含提示');
  });

  test('无 dateContext 时不出现时间段', () => {
    const prompt = buildSystemPrompt('daily', sourceCareer, 'career', {});
    assert.ok(!prompt.includes('今日背景'));
  });
});

// ════════════════════════════════════════════════════════════════
// 4. checkAiFlavor / inspectGeneratedOutput：反 AI 味量化规则
// ════════════════════════════════════════════════════════════════

describe('checkAiFlavor — 反 AI 味规则（5 条基准）', () => {
  test('连续感叹号（半角/全角）', () => {
    assert.strictEqual(checkAiFlavor(['冲啊！！', '稳住，我们能赢！', '加油！', '好好休息', '为你欢呼']).rule, 'double_exclamation');
    assert.strictEqual(checkAiFlavor(['冲啊!!', '稳住，我们能赢!', '加油!', '好好休息', '为你欢呼']).rule, 'double_exclamation');
  });

  test('感叹号边界：5 个放行 / 6 个拒（无连续）', () => {
    const five = [
      '冲呀！今天也要元气满满',
      '稳住别慌我们能赢下来！',
      '为你欢呼的这一刻太耀眼了！',
      '翻出旧录像又看了一遍！',
      '晚饭后去超话转一圈！真惬意',
    ];
    assert.strictEqual(checkAiFlavor(five), null, '5 个感叹号应放行');
    const six = [...five.slice(0, 4), '晚饭后去超话转一圈！真惬意！'];
    assert.strictEqual(checkAiFlavor(six).rule, 'exclamation_density', '6 个感叹号应拒绝');
  });

  test('句首雷同边界：2 条同开头放行 / 3 条同开头拒', () => {
    const twoSame = [
      '今天也要加油呀朋友们',
      '晨光正好别辜负这时光',
      '今天不许丧气', // 「今」第 2 次 → 放行
      '翻出你的旧比赛录像重温',
      '晚饭吃得好饱有点困了',
    ];
    assert.strictEqual(checkAiFlavor(twoSame), null, '2 条同开头应放行');
    const threeSame = [
      '今天也要加油呀朋友们',
      '今天不许丧气',
      '今天就是最好的一天', // 「今」第 3 次 → 拒绝
      '翻出你的旧比赛录像重温',
      '晚饭吃得好饱有点困了',
    ];
    const result = checkAiFlavor(threeSame);
    assert.strictEqual(result.rule, 'same_opening');
    assert.ok(result.detail.includes('今'));
  });

  test('抽象词边界：4 个不同抽象词放行 / 5 个拒', () => {
    const four = [
      '梦想还是要有的万一实现了',
      '热爱可抵岁月漫长',
      '信念这东西真的很奇妙',
      '永远支持你到底',
      '晚饭吃得好饱有点困了',
    ];
    assert.strictEqual(checkAiFlavor(four), null, '4 个抽象词应放行');
    const five = [
      '梦想还是要有的万一实现了',
      '热爱可抵岁月漫长',
      '信念这东西真的很奇妙',
      '永远支持你到底',
      '这一次一定要全力以赴',
    ];
    const result = checkAiFlavor(five);
    assert.strictEqual(result.rule, 'abstract_terms');
  });

  test('排比三连句式（不只…更 / 既是…又是 / 没有…只有）', () => {
    assert.strictEqual(checkAiFlavor(['不只是比赛，更是信仰', '为你欢呼', '好好休息', '翻翻旧录像', '晚饭吃过了']).rule, 'parallel_pattern');
    assert.strictEqual(checkAiFlavor(['既是对手，又是朋友', '好好休息', '为你欢呼', '翻翻旧录像', '晚饭吃过了']).rule, 'parallel_pattern');
    assert.strictEqual(checkAiFlavor(['没有退路，只有前行', '好好休息', '为你欢呼', '翻翻旧录像', '晚饭吃过了']).rule, 'parallel_pattern');
  });

  test('自然 5 条文案不误伤', () => {
    assert.strictEqual(
      checkAiFlavor([
        '昨晚看到你的高光集锦，还是那么秀',
        '等你回来的每一天都有在认真生活',
        '今天喝到了好喝的奶茶，突然想到你',
        '翻出去年夏天的比赛录像又看了一遍',
        '晚饭后散步的时候在超话刷到你的图',
      ]),
      null
    );
  });
});

describe('inspectGeneratedOutput — 条数与 ai_flavor 校验接入', () => {
  const EMPTY_SOURCE = { refs: [], promptLines: [] };
  // 可通过全部校验的 5 条自然文案基线
  const NATURAL_FIVE = [
    '昨晚看到你的高光集锦，还是那么秀',
    '等你回来的每一天都有在认真生活',
    '今天喝到了好喝的奶茶，突然想到你',
    '翻出去年夏天的比赛录像又看了一遍',
    '晚饭后散步的时候在超话刷到你的图',
  ];

  test('恰好 5 条放行；4 条 / 6 条均 line_count 拒绝', () => {
    const ok = inspectGeneratedOutput({ lines: [...NATURAL_FIVE], emoji_caption: 'x' }, EMPTY_SOURCE, { humanize: true });
    assert.strictEqual(ok.ok, true, '5 条应放行');
    assert.strictEqual(ok.output.lines.length, CHEER_LINE_COUNT);
    for (const n of [4, 6]) {
      const lines = n === 4 ? NATURAL_FIVE.slice(0, 4) : [...NATURAL_FIVE, '补一条凑数的文案而已呀'];
      const result = inspectGeneratedOutput({ lines, emoji_caption: 'x' }, EMPTY_SOURCE, { humanize: true });
      assert.strictEqual(result.ok, false, `${n} 条应拒绝`);
      assert.strictEqual(result.reason, 'line_count');
    }
  });

  test('AI 腔命中 → reason:ai_flavor（放在内容安全校验之前）', () => {
    // 每条均 ≥10 字符，确保不会被 line_length 前置拦截
    const output = {
      lines: ['我们一定要冲啊！！冲上巅峰', '稳住别慌，我们一定能赢下来', '今天也为你加油，好好休息', '翻出旧录像又看了一遍呀', '晚饭后去超话转了一圈呢'],
      emoji_caption: 'x',
    };
    const result = inspectGeneratedOutput(output, EMPTY_SOURCE, { humanize: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'invalid_output');
    assert.strictEqual(result.reason, 'ai_flavor');
    assert.strictEqual(result.ai.rule, 'double_exclamation');
  });

  test('humanize:false 时跳过 AI 味校验', () => {
    const output = {
      lines: ['我们一定要冲啊！！冲上巅峰', '稳住别慌，我们一定能赢下来', '今天也为你加油，好好休息', '翻出旧录像又看了一遍呀', '晚饭后去超话转了一圈呢'],
      emoji_caption: 'x',
    };
    const result = inspectGeneratedOutput(output, EMPTY_SOURCE, { humanize: false });
    assert.strictEqual(result.ok, true, '关闭校验后 AI 腔文案应放行');
  });

  test('数据不实校验优先于 AI 味校验', () => {
    const output = {
      lines: ['昨天 99 连胜太强了', '稳住别慌，我们一定能赢下来', '今天也为你加油，好好休息吧', '翻出旧录像又看了一遍呀', '晚饭后去超话转了一圈呢'],
      emoji_caption: 'x',
    };
    const result = inspectGeneratedOutput(output, EMPTY_SOURCE, { humanize: true });
    assert.strictEqual(result.reason, 'ungrounded_number', '未提供的数据应先拦截');
  });
});

describe('CHEER_LINE_COUNT 与 prompt / 重试文案一致性', () => {
  const sourceCareer = buildGroundedSource(OVERVIEW, 'career');

  test('常量值为 5 / 字数下限为 20', () => {
    assert.strictEqual(CHEER_LINE_COUNT, 5);
    assert.strictEqual(CHEER_LINE_MIN_CHARS, 20);
  });

  test('system prompt 条数口径与常量一致', () => {
    const prompt = buildSystemPrompt('daily', sourceCareer, 'career', {});
    assert.ok(prompt.includes(`必须输出 ${CHEER_LINE_COUNT} 条中文短句`), '条数指令应与常量一致');
    assert.ok(prompt.includes(`恰好包含 ${CHEER_LINE_COUNT} 个字符串`), 'JSON 指令应与常量一致');
    assert.ok(prompt.includes(`${CHEER_LINE_COUNT} 条文案开头雷同`), 'humanize 指南条数应与常量一致');
    assert.ok(!prompt.includes('必须输出 3 条'), '不应残留 3 条口径');
  });

  test('system prompt 字数下限口径与常量一致（防每条变短的压缩行为）', () => {
    const prompt = buildSystemPrompt('daily', sourceCareer, 'career', {});
    assert.ok(prompt.includes(`每条必须不少于 ${CHEER_LINE_MIN_CHARS} 个字`), '正文字数下限应与常量一致');
    assert.ok(prompt.includes(`每条不少于 ${CHEER_LINE_MIN_CHARS} 个字`), 'JSON 指令行应重复字数下限');
    assert.ok(!prompt.includes('不得少于 10 字'), '不应残留 10 字下限');
  });

  test('重试提示条数与字数口径与常量一致', () => {
    const lineLengths = Array.from({ length: CHEER_LINE_COUNT }, () => 12);
    const retryLen = buildRetryInstruction({ reason: 'line_length', lineLengths });
    assert.ok(retryLen.includes(`${CHEER_LINE_COUNT} 条文案的字符数`));
    assert.ok(retryLen.includes(`每条不少于 ${CHEER_LINE_MIN_CHARS} 个字`), 'line_length 重试应带 20 字下限');
    assert.ok(buildRetryInstruction({ reason: 'ai_flavor', ai: { detail: '句式雷同' } }).includes(`让 ${CHEER_LINE_COUNT} 条文案`));
    const retryDefault = buildRetryInstruction({});
    assert.ok(retryDefault.includes(`恰好 ${CHEER_LINE_COUNT} 条`));
    assert.ok(retryDefault.includes(`每条不少于 ${CHEER_LINE_MIN_CHARS} 个字`));
    assert.ok(!retryDefault.includes('恰好 3 条'), '不应残留 3 条口径');
    assert.ok(!retryLen.includes('至少 10 个字符'), '不应残留 10 字口径');
  });
});

describe('collectAnchorNumbers + ungrounded_number 白名单', () => {
  const EMPTY_SOURCE = { refs: [], promptLines: [] };

  function buildCtx(dateStr) {
    const phase = dc.resolveEventPhase(EVENT_ASIAN_GAMES, dateStr);
    const dateContext = dc.getDateContext(dateStr, phase, EVENT_ASIAN_GAMES);
    return { dateContext, eventHit: { _id: 'e1' }, eventPhase: phase };
  }

  test('collectAnchorNumbers：含 dateContext、eventPhase 与 refs 中的数字', () => {
    const ctx = buildCtx('2026-08-29');
    ctx.dateContext.anchors.push({ kind: 'custom', text: '9月2日 星期三' });
    ctx.eventPhase.round = 3;
    const numbers = collectAnchorNumbers(ctx, { refs: [{ value: '56.7%' }] });
    assert.ok(numbers.includes('30'), '应保留事件剩余天数 30');
    assert.ok(numbers.includes('9'), '应收集 dateContext 文本中的日期数字');
    assert.ok(numbers.includes('3'), '应收集 eventPhase 中的数字');
    assert.ok(numbers.includes('56.7%'), '应收集 refs 中的数字');
  });

  test('倒数文案带天数数字：锚点数字在白名单内放行（回归：此前必被 ungrounded_number 打回）', () => {
    const ctx = buildCtx('2026-09-21'); // T-7 countdown
    const output = {
      lines: [
        '倒计时 7 天，金牌赛越来越近了，期待你站上亚运赛场',
        '日常来报到，今天也要好好吃饭好好休息',
        '翻着你的比赛录像，等你凯旋的那一天',
        '晚饭后刷到了你的采访片段，笑得很开心',
        '早睡早起，养足精神迎接每一天',
      ],
      emoji_caption: '⭐️',
    };
    const result = inspectGeneratedOutput(output, EMPTY_SOURCE, { humanize: true, anchorNumbers: collectAnchorNumbers(ctx) });
    assert.strictEqual(result.ok, true, '倒计时天数应放行');
  });

  test('无锚点数字时，未提供的数据仍被拦截', () => {
    const output = {
      lines: ['昨天 99 连胜太强了', '稳住别慌，我们一定能赢下来', '今天也为你加油，好好休息吧', '翻出旧录像又看了一遍呀', '晚饭后去超话转了一圈呢'],
      emoji_caption: 'x',
    };
    const result = inspectGeneratedOutput(output, EMPTY_SOURCE, { humanize: true, anchorNumbers: ['30'] });
    assert.strictEqual(result.reason, 'ungrounded_number', '白名单外的数字仍应拦截');
  });
});

// ════════════════════════════════════════════════════════════════
// 5. settings-store：事件表 CRUD + 配置合并（内存 mock DB）
// ════════════════════════════════════════════════════════════════

describe('settings-store — 事件表与 cheer 设置（mock DB）', () => {
  let memDb; // name -> Map(id -> doc)
  const originalLoad = Module._load;

  beforeEach(() => {
    memDb = new Map();
    Module._load = function (request, parent, isMain) {
      if (request === '../db/mongo' || request === '../db') {
        return {
          collection: async (name) => {
            if (!memDb.has(name)) memDb.set(name, new Map());
            const store = memDb.get(name);
            function query(filter = {}, sort = null, limitN, skipN) {
              return {
                where(f) { return query(Object.assign({}, filter, f), sort, limitN, skipN); },
                orderBy(field, dir) {
                  return query(filter, Object.assign({}, sort || {}, { [field]: dir === 'desc' ? -1 : 1 }), limitN, skipN);
                },
                limit(n) { return query(filter, sort, n, skipN); },
                skip(n) { return query(filter, sort, limitN, n); },
                async get() {
                  let arr = [...store.values()];
                  arr = arr.filter((d) => Object.entries(filter).every(([k, v]) => {
                    if (v && typeof v === 'object' && '$exists' in v) {
                      return d[k] !== undefined && d[k] !== null;
                    }
                    return d[k] === v;
                  }));
                  if (sort) {
                    const keys = Object.keys(sort);
                    arr.sort((a, b) => {
                      for (const k of keys) {
                        const dir = sort[k];
                        if (a[k] < b[k]) return -dir;
                        if (a[k] > b[k]) return dir;
                      }
                      return 0;
                    });
                  }
                  if (skipN) arr = arr.slice(skipN);
                  if (limitN != null) arr = arr.slice(0, limitN);
                  return { data: JSON.parse(JSON.stringify(arr)) };
                },
              };
            }
            return {
              doc(id) {
                return {
                  async get() {
                    const d = store.get(id);
                    return { data: d ? [JSON.parse(JSON.stringify(d))] : [] };
                  },
                  async set(data) { store.set(id, Object.assign({}, data, { _id: id })); },
                  async update(data) { const d = store.get(id); if (d) store.set(id, Object.assign({}, d, data)); },
                  async remove() { store.delete(id); },
                };
              },
              where(filter) { return query(filter); },
              orderBy(field, dir) { return query({}, { [field]: dir === 'desc' ? -1 : 1 }); },
            };
          },
        };
      }
      return originalLoad.apply(this, arguments);
    };
    // 每次重新加载 settings-store，清掉模块级缓存
    delete require.cache[require.resolve('../src/services/settings-store')];
  });

  afterEach(() => {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/services/settings-store')];
  });

  async function loadStore() {
    return require('../src/services/settings-store');
  }

  test('setCheerEvent：upsert 幂等（同 _id 不产生重复）', async () => {
    const store = await loadStore();
    const first = await store.setCheerEvent(Object.assign({}, EVENT_ASIAN_GAMES, { _id: 'ev_1' }));
    await new Promise((r) => setTimeout(r, 5)); // updated_at 毫秒级变化
    const second = await store.setCheerEvent(Object.assign({}, EVENT_ASIAN_GAMES, { _id: 'ev_1', description: '改描述' }));
    assert.strictEqual(first._id, 'ev_1');
    assert.strictEqual(second._id, 'ev_1');
    assert.notStrictEqual(second.updated_at, first.updated_at, 'updated_at 应更新');
    const all = await store.getCheerEvents();
    assert.strictEqual(all.length, 1, '同 _id 应只保留一条');
    assert.strictEqual(all[0].description, '改描述');
  });

  test('setCheerEvent：字段缺省与校验', async () => {
    const store = await loadStore();
    // 缺省值
    const ev = await store.setCheerEvent({ date: '2026-09-28', title: '测试赛' });
    assert.strictEqual(ev.leadDays, 30, 'leadDays 缺省 30');
    assert.strictEqual(ev.active, true, 'active 缺省 true');
    assert.strictEqual(ev.type, 'match', 'type 缺省 match');
    // 非法 type 回退 match
    const ev2 = await store.setCheerEvent({ date: '2026-09-28', title: '测试赛2', type: 'weird' });
    assert.strictEqual(ev2.type, 'match');
    // 校验失败抛错
    await assert.rejects(() => store.setCheerEvent({ date: '2026/09/28', title: 'x' }), /date 必须为 YYYY-MM-DD/);
    await assert.rejects(() => store.setCheerEvent({ date: '2026-09-28', title: '  ' }), /title 必填/);
  });

  test('getActiveEventsForDate：窗口过滤 + active 排除 + 按剩余天数排序', async () => {
    const store = await loadStore();
    await store.setCheerEvent({ _id: 'a', date: '2026-09-28', title: '金牌赛', leadDays: 30 });
    await store.setCheerEvent({ _id: 'b', date: '2026-10-01', title: '小组赛', leadDays: 7 });
    await store.setCheerEvent({ _id: 'c', date: '2026-10-05', title: '已停用', leadDays: 30, active: false });
    await store.setCheerEvent({ _id: 'd', date: '2026-08-01', title: '已过期', leadDays: 30 });
    // 2026-09-26：a（T-2）应排在 b（T-5）之前，按剩余天数升序
    const hits = await store.getActiveEventsForDate('2026-09-26');
    assert.strictEqual(hits.length, 2, '停用与过期事件应被排除');
    assert.deepStrictEqual(hits.map((h) => h.title), ['金牌赛', '小组赛'], '应按剩余天数升序');
    assert.strictEqual(hits[0].phase.phase, 'countdown');
    // 2026-09-18：a 在 T-10 里程碑（preview），b 超窗（leadDays 7）
    const hits2 = await store.getActiveEventsForDate('2026-09-18');
    assert.strictEqual(hits2.length, 1);
    assert.strictEqual(hits2[0].title, '金牌赛');
    assert.strictEqual(hits2[0].phase.phase, 'preview');
  });

  test('deleteCheerEvent 删除', async () => {
    const store = await loadStore();
    await store.setCheerEvent({ _id: 'del_1', date: '2026-09-28', title: '待删' });
    await store.deleteCheerEvent('del_1');
    const all = await store.getCheerEvents();
    assert.strictEqual(all.length, 0);
    await assert.rejects(() => store.deleteCheerEvent(''), /invalid event id/);
  });

  test('getCheerSettings：无 DB 配置回退 env 默认，写入后合并读取', async () => {
    const store = await loadStore();
    const defaults = await store.getCheerSettings();
    assert.strictEqual(defaults.mode, 'season', '未设置 env 时应读取默认 season');
    assert.strictEqual(defaults.date_context_enabled, true);
    assert.strictEqual(defaults.humanize_enabled, true);
    assert.strictEqual(defaults.event_context_enabled, true);
    assert.strictEqual(defaults.source, 'env');

    await store.setCheerSettings({ date_context_enabled: false, humanize_enabled: false });
    const merged = await store.getCheerSettings();
    assert.strictEqual(merged.date_context_enabled, false);
    assert.strictEqual(merged.humanize_enabled, false);
    assert.strictEqual(merged.event_context_enabled, true, '未提及字段应保留');
    assert.strictEqual(merged.source, 'db');
  });

  test('setCheerDataMode 校验', async () => {
    const store = await loadStore();
    await store.setCheerDataMode('emotion');
    assert.strictEqual((await store.getCheerDataMode()).mode, 'emotion');
    await assert.rejects(() => store.setCheerDataMode('weird'), /invalid data_mode/);
  });
});
