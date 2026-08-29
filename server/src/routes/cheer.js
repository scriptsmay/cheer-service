'use strict';

/**
 * cheer 路由 — ← ai-cheer
 * AI 应援文案生成
 */

const express = require('express');
const { randomUUID } = require('node:crypto');
const { collection, runTransaction } = require('../db/mongo');
const { generateText } = require('../services/ai');
const { resolveIdentity } = require('../services/identity');
const { successResponse, errorResponse } = require('../services/response');
const { isContentBlocked } = require('../lib/ai-utils');
const { getCheerSettings, getActiveEventsForDate } = require('../services/settings-store');
const { getDateContext } = require('../lib/date-context');
const {
  getRequestId, getClientIp, shanghaiDate, normalizeClientId,
  isValidClientId, normalizeRequestId, hashValue, formatRate,
  textLength, isObject, getErrorMessage,
} = require('../utils/helpers');
const config = require('../config/env');

// 单次生成条数（单一事实来源：prompt / 校验 / 重试文案均由此动态拼装）
const CHEER_LINE_COUNT = 5;
// 条数变多后触发校验重试的概率上升，多一次重试换生成成功率
const MAX_GENERATION_ATTEMPTS = 3;
const ALLOWED_MOODS = new Set(['victory', 'low', 'daily', 'hope']);
const MOOD_ALIASES = { eager: 'hope' };
const MOOD_PROMPTS = {
  victory: '胜利时刻，全力欢呼！用追竞女孩/男孩最燃的语气庆祝，有夺冠氛围感',
  low: '低谷时期，温暖守护。像粉丝之间互相打气一样自然，相信选手会找回状态',
  daily: '日常陪伴，轻松有活力。像超话里的自然分享，元气但不刻意喊口号',
  hope: '求胜时刻，热血拉满！用热血坚定的语气给下一场蓄力，气势不能输',
};
const MOOD_NAMES = { victory: '胜利', low: '低谷', daily: '日常', hope: '求胜' };
const DAY_MS = 24 * 60 * 60 * 1000;

const router = express.Router();

router.post('/', async (req, res) => {
  const requestId = getRequestId(req);

  const identity = await resolveIdentity(req);
  if (!identity.ok) return errorResponse(res, 401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId);

  const body = req.body || {};
  const moodInput = typeof body.mood === 'string' ? body.mood.toLowerCase() : 'daily';
  const mood = MOOD_ALIASES[moodInput] || moodInput;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const clientId = normalizeClientId(body.client_id || body._cid || 'unknown');

  if (!ALLOWED_MOODS.has(mood) || textLength(text) > 120 || !isValidClientId(clientId)) {
    return errorResponse(res, 400, 'INVALID_ARGUMENT', '心情、补充文字或 client_id 不合法', requestId);
  }
  if (isContentBlocked(text)) {
    return errorResponse(res, 451, 'CONTENT_BLOCKED', '补充文字未通过内容安全检查', requestId);
  }

  try {
    const settings = await getCheerSettings();
    const dataMode = settings.mode;
    const overview = dataMode === 'emotion' ? null : await getLatestOverview();
    const source = buildGroundedSource(overview, dataMode);
    const todayStr = shanghaiDate().date;

    // ── 时间上下文 / 赛事事件 / 反 AI 味 组装（全部开关可控，线上可关）──
    let eventHit = null;
    let eventPhase = null;
    if (settings.event_context_enabled !== false) {
      const hits = await getActiveEventsForDate(todayStr);
      if (hits.length) {
        eventHit = hits[0];        // 主事件（剩余天数最近）
        eventPhase = eventHit.phase;
      }
    }
    let dateContext = null;
    if (settings.date_context_enabled !== false) {
      // 避开与昨天相同的赛事句式（查询失败不影响主流程）
      const avoidText = await getLastEventText(identity.subjectId);
      dateContext = getDateContext(todayStr, eventPhase, eventHit, avoidText);
    }
    const humanizeEnabled = settings.humanize_enabled !== false;

    // 事件 refs 注入：仅倒数/临场/当天档进 refs（前端应援卡展示），预热档只在 prompt 轻提
    if (eventPhase && eventPhase.phase !== 'preview' && eventHit) {
      addRef(source.refs, eventHit.refs_label || '今日赛事', eventHit.refs_value || eventHit.title, 'cheer_events');
      source.promptLines = source.refs.map((r) => `${r.label}：${r.value}`);
    }

    const idempotencyKey = normalizeRequestId(req.headers?.['x-request-id'] || requestId);
    const quota = await consumeAiQuota({
      subjectId: identity.subjectId,
      ipHash: hashValue(getClientIp(req), config.ipHashSalt),
      requestId: idempotencyKey,
      date: shanghaiDate().date,
    });

    if (!quota.allowed) return errorResponse(res, 429, 'RATE_LIMITED', '今日应援生成额度已用完', requestId, 86400);
    if (quota.response) return successResponse(res, quota.response, requestId);

    const ctx = { dateContext, eventHit, eventPhase, humanizeEnabled };
    const generation = await generateValidatedOutput({ mood, text, source, requestId, mode: dataMode, ctx });
    if (!generation.ok) {
      await markReceipt(quota.receiptId, 'failed');
      if (generation.failure.kind === 'blocked_content') {
        return errorResponse(res, 451, 'CONTENT_BLOCKED', '生成内容未通过安全检查', requestId);
      }
      if (generation.failure.kind === 'invalid_output') {
        return errorResponse(res, 503, 'AI_OUTPUT_INVALID', '生成格式不稳定，请稍后重试', requestId);
      }
      return errorResponse(res, 503, 'AI_UNAVAILABLE', '文案生成暂时不可用，请稍后重试', requestId);
    }

    const safeOutput = generation.output;
    const reportId = randomUUID();
    const now = new Date();
    const sourceSnapshotAt = source.snapshotAt || now.toISOString();

    const payload = {
      lines: safeOutput.lines,
      emoji_caption: safeOutput.emoji_caption,
      report_id: reportId,
      refs: source.refs,
      source_snapshot_at: sourceSnapshotAt,
    };

    const aiReportsCol = await collection('ai_reports');
    const reportDoc = {
      report_id: reportId,
      module: 'aiCheer',
      status: 'active',
      data_mode: dataMode,
      subject_id: identity.subjectId,
      client_id_hash: hashValue(clientId, config.ipHashSalt),
      user_input: { mood, text_summary: text.slice(0, 40) },
      ai_output: safeOutput,
      refs: source.refs,
      source_snapshot_at: sourceSnapshotAt,
      timestamp: now.getTime(),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
    };
    // 多样性追溯字段：时间上下文与事件命中明细
    if (dateContext) {
      reportDoc.date_context = {
        date_label: dateContext.dateLabel,
        anchors: dateContext.anchors, // [{kind,text}]
      };
    }
    if (eventHit && eventPhase) {
      reportDoc.event_hit = eventHit._id;
      reportDoc.event_phase = eventPhase.phase;
      reportDoc.event_days_until = eventPhase.daysUntil;
    }
    await aiReportsCol.doc(reportId).set(reportDoc);

    const usageCol = await collection('usage_limits');
    await usageCol.doc(quota.receiptId).update({ status: 'success', response: payload, updated_at: now.toISOString() });

    return successResponse(res, payload, requestId);
  } catch (error) {
    console.error('[ai-cheer] request failed', { requestId, message: getErrorMessage(error) });
    return errorResponse(res, 503, 'WRITE_FAILED', '服务暂时不可用，请稍后重试', requestId);
  }
});

// ── 内部函数 ──

async function generateValidatedOutput({ mood, text, source, requestId, mode, ctx }) {
  let lastFailure = { kind: 'invalid_output', reason: 'not_generated' };
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const messages = [
      { role: 'system', content: buildSystemPrompt(mood, source, mode, ctx) },
      { role: 'user', content: buildUserPrompt(mood, text, source) },
    ];
    if (attempt > 1) messages.push({ role: 'user', content: buildRetryInstruction(lastFailure) });

    let result;
    try {
      result = await generateText({ messages, temperature: 0.85, jsonMode: true });
    } catch (error) {
      lastFailure = { kind: 'model_error', reason: getErrorMessage(error) };
      console.warn('[ai-cheer] model attempt failed', { requestId, attempt, message: lastFailure.reason });
      continue;
    }

    const validation = inspectGeneratedOutput(parseGeneratedText(result && result.text), source, {
      humanize: !ctx || ctx.humanizeEnabled !== false,
      anchorNumbers: collectAnchorNumbers(ctx),
    });
    console.log('[ai-cheer] model completed', { requestId, attempt, totalTokens: result?.usage?.total_tokens });
    if (validation.ok) return { ok: true, output: validation.output };

    lastFailure = validation;
    console.warn('[ai-cheer] output rejected', { requestId, attempt, reason: validation.reason });
  }
  return { ok: false, failure: lastFailure };
}

async function getLatestOverview() {
  const col = await collection('season_summaries');
  const result = await col.orderBy('updated_at', 'desc').limit(1).get();
  return result.data && result.data.length ? result.data[0] : null;
}

function buildGroundedSource(overview, mode = 'season') {
  if (mode === 'emotion') return { refs: [], snapshotAt: '', promptLines: [] };
  if (!overview) return { refs: [], snapshotAt: '', promptLines: [] };
  const envelope = isObject(overview.data) ? overview.data : {};
  const data = isObject(envelope.data) ? envelope.data : envelope;
  const seasonId = typeof overview.season === 'string' ? overview.season : '';
  // career 模式强制走生涯汇总，忽略"当前赛季"口径（选手缺赛期数据已冻结）
  const seasonStats = mode === 'career'
    ? null
    : (Array.isArray(data.season_stats)
      ? data.season_stats.find((item) => isObject(item) && item.season_id === seasonId)
      : null);
  const career = isObject(data.career_summary) ? data.career_summary : {};
  const stats = seasonStats || career;
  const statsLabel = seasonStats ? '当前赛季' : '生涯';
  const heroes = Array.isArray(data.hero_stats) ? [...data.hero_stats] : [];
  heroes.sort((a, b) => Number((b && b.battles) || 0) - Number((a && a.battles) || 0));
  const refs = [];
  addRef(refs, `${statsLabel} KDA`, stats.kda_ratio, 'season_summaries');
  addRef(refs, `${statsLabel}胜率`, formatRate(stats.win_rate), 'season_summaries');
  addRef(refs, `${statsLabel}对局数`, stats.battles ?? stats.total_battles, 'season_summaries');
  addRef(refs, `${statsLabel} MVP 次数`, stats.mvp ?? stats.mvp_count, 'season_summaries');
  addRef(refs, `${statsLabel}场均助攻`, stats.avg_assists, 'season_summaries');
  const heroLabel = '常用英雄（按出场数）';
  const heroSummary = heroes.filter((item) => isObject(item) && typeof item.hero_name === 'string' && item.hero_name).slice(0, 5).map(formatHeroSummary).join('、');
  addRef(refs, heroLabel, heroSummary, 'season_summaries');
  // 只保留前 6 条数据，避免 prompt 太长
  const trimmedRefs = refs.slice(0, 6);
  // career 口径下 overview.updated_at 只代表 season_summaries 文档刷新时间，
  // 不等于生涯数据的截止时间，改用 career_summary 自带时间，没有则留空避免误导
  const rawSnapshotAt = seasonStats
    ? (overview.updated_at || overview.source_snapshot_at)
    : (career.updated_at || career.snapshot_at || '');
  return {
    refs: trimmedRefs,
    promptLines: trimmedRefs.map((r) => `${r.label}：${r.value}`),
    snapshotAt: normalizeSnapshotAt(rawSnapshotAt),
    statsScope: seasonStats ? 'season' : 'career',
  };
}

function addRef(refs, label, value, source) {
  if (value === null || value === undefined || value === '' || value === '暂无') return;
  refs.push({ label, value: String(value), source });
}

function formatHeroSummary(hero) {
  const details = [];
  const battles = Number(hero.battles);
  if (Number.isFinite(battles) && battles >= 0) details.push(`${battles}局`);
  const winRate = formatRate(hero.win_rate);
  if (winRate) details.push(`胜率${winRate}`);
  return details.length ? `${hero.hero_name}（${details.join('，')}）` : hero.hero_name;
}

const DEFAULT_PROMPT = `
你是 KPL 选手无言的粉丝应援文案助手。

受众是 18 岁左右的追竞年轻人。文案要像粉丝在超话自然发帖：口语化、有活力、有真实情绪，不要写成官方宣传稿，也不要使用"老友""稳重"等长辈口吻。

所有输出必须使用简体中文，禁止出现繁体字。

粉圈词不是必选项。可以按语境偶尔使用"同担""守护""冲冲冲""杀回来"等表达，但每个词在整次输出中最多出现一次；没有合适语境时就不用。优先通过自然的语气和节奏体现粉丝氛围。

多条文案要从不同角度表达期待、鼓励、陪伴、认可或热血感，句式和开头不能雷同。避免套话、口号堆叠、连续感叹号，以及每句都称呼选手或粉丝群体。

只允许引用下方"可引用数据"中明确提供的具体数字、百分比和英雄名；没有提供的数据不得猜测或补充。数据按语境自然选用即可，不要为了塞数据牺牲口语感。五条文案中最多三条引用数据，至少两条完全不引用数据、只表达自然情绪。
所有数字必须使用阿拉伯数字（如 4.29、56.7%、28局），禁止使用中文数字（如四點二九、五十六点七、二十八局）。

必须输出 5 条中文短句，每条建议 30 至 50 字且不得少于 10 字；另输出一句简短的 emoji_caption。emoji_caption 也要自然，不要复述短句。

不得使用传统球类运动词汇，不得声称单场 MVP、本周表现或未提供的赛程结果。

参考自然程度，不要照抄：
- 今天也期待你的下一次亮相。
- 慢慢找回节奏，我们一直都在。
- 热爱不会缺席，放开手去拼！
`;

// 缺赛期语气变体（去掉前瞻性赛程表述）
const MOOD_PROMPTS_OFFSEASON = {
  victory: MOOD_PROMPTS.victory,
  low: MOOD_PROMPTS.low,
  daily: MOOD_PROMPTS.daily,
  hope: '热血坚定，把这份能量化作长期陪伴与信任，气势不能输',
};

// 缺赛期约束：选手不参与后续赛程时，禁止前瞻性赛程表述
const OFFSEASON_CONSTRAINT = `
当前选手处于缺赛期，不参与后续赛程。禁止使用"下一场""接下来的比赛""本赛季赛程""下轮""复出之战"等指向具体未来对局的表述，也不得暗示比赛结果。
可以回望已有的生涯高光、表达陪伴与长期期待，语气保持自然，不要把缺赛写成悲情叙事。
`;

// 缺赛期约束·亚运豁免版：选手正在参加国家赛事时，KPL 禁令保留，但允许围绕亚运赛事应援
// 事件命中时用它「正向替换」OFFSEASON_CONSTRAINT，避免模型收到矛盾指令
const OFFSEASON_CONSTRAINT_ASIAN_GAMES = `
当前选手处于缺赛期，不参与 KPL 后续赛程。禁止使用"下一场""接下来的比赛""本赛季赛程""下轮""复出之战"等指向 KPL 具体未来对局的表述，也不得暗示 KPL 比赛结果。
但选手正在参加国家赛事（2026 名古屋亚运会），可以自然围绕亚运赛事应援，允许"亚运""金牌赛""为国出征"等表达；临近比赛日的赛事倒计时可以提及。
可以回望已有的生涯高光、表达陪伴与长期期待，语气保持自然，不要把缺赛写成悲情叙事。
`;

// 反 AI 味指南：写入 system prompt 的「禁止清单」（可通过 cheer_settings.humanize_enabled 关闭）
// 条数口径由 CHEER_LINE_COUNT 动态拼装，避免条数调整后文案漂移
const HUMANIZE_GUIDE = `
避免 AI 腔：禁止排比三连句式（"不只是…更是…"）、禁止连续感叹号（最多一个）、禁止抽象词堆叠（梦想/热爱/永远/信念 每词整次输出最多一次）、禁止句式同构（${CHEER_LINE_COUNT} 条文案开头雷同）、禁止口号式收尾（每句都是正能量总结）。
像粉丝真的在打字：有停顿、有细节、允许一点点随意，不要每句都像精心设计的金句。
`;

// 时间上下文注入提示（date_context_enabled 关闭时不出现）
const DATE_CONTEXT_HINT = `
可以自然地融入节气/节日氛围或今日赛事，但每条文案最多提及一次时间语境，不要为了塞日期破坏口语感，也不要写成天气预报或赛事播报。
`;

// 倒数/临场/当天档强提示：赛事语境从「可选」升级为「必含」（条数口径动态拼装）
const EVENT_STRONG_HINT = `
今日赛事是本次文案的核心素材：${CHEER_LINE_COUNT} 条文案中至少一条要自然体现这一赛事语境（倒计时、临场期待或当日应援均可），
倒计时可以直接使用今日背景中给出的天数；其余文案保持日常陪伴感，不要每条都写赛事。
`;

function buildSystemPrompt(mood, source, mode = 'season', ctx = {}) {
  const isOffseason = mode === 'career' || mode === 'emotion';
  const moodPrompts = isOffseason ? MOOD_PROMPTS_OFFSEASON : MOOD_PROMPTS;
  const parts = [DEFAULT_PROMPT];
  if (isOffseason) {
    // 事件命中（国家赛事）时用「正向替换」的豁免版约束，保留 KPL 禁令但放行亚运表述
    parts.push(ctx.eventHit ? OFFSEASON_CONSTRAINT_ASIAN_GAMES : OFFSEASON_CONSTRAINT);
  }
  if (ctx.humanizeEnabled !== false) parts.push(HUMANIZE_GUIDE);
  if (ctx.dateContext) {
    // 倒数/临场/当天档赛事为必含素材；预热 preview 档（含里程碑日）维持软提示
    const strongEvent = Boolean(
      ctx.eventHit && ctx.eventPhase && ['countdown', 'eve', 'today'].includes(ctx.eventPhase.phase)
    );
    parts.push(
      `今日背景：${ctx.dateContext.dateLabel}，${ctx.dateContext.anchors.map((a) => a.text).join('；')}\n${strongEvent ? EVENT_STRONG_HINT : DATE_CONTEXT_HINT}`
    );
  }
  parts.push(`语气：${moodPrompts[mood]}`);
  parts.push(`可引用数据：${source.promptLines.length ? source.promptLines.join('；') : '无，生成纯情绪应援文案'}`);
  const jsonExample = `{"lines":[${Array.from({ length: CHEER_LINE_COUNT }, (_, i) => `"文案${i + 1}"`).join(',')}],"emoji_caption":"配文"}`;
  parts.push(`只输出合法 JSON，lines 必须恰好包含 ${CHEER_LINE_COUNT} 个字符串：${jsonExample}`);
  return parts.join('\n');
}

function buildUserPrompt(mood, text, source) {
  const lines = [`心情：${MOOD_NAMES[mood]}`, `数据条目数：${source.refs.length}`];
  if (text) lines.push(`用户补充：${text}`);
  lines.push('请生成可直接复制发布的应援文案。');
  return lines.join('\n');
}

function parseGeneratedText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const match = text.replace(/```(?:json)?/giu, '').trim().match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim())
      : [];
    return { lines, emoji_caption: typeof parsed.emoji_caption === 'string' ? parsed.emoji_caption.trim() : '' };
  } catch (_) {
    return null;
  }
}

function inspectGeneratedOutput(output, source, opts = {}) {
  if (!output || !Array.isArray(output.lines) || output.lines.length !== CHEER_LINE_COUNT) {
    return { ok: false, kind: 'invalid_output', reason: 'line_count' };
  }
  const lineLengths = output.lines.map(textLength);
  if (output.lines.some((line, index) => !line || lineLengths[index] < 10)) {
    return { ok: false, kind: 'invalid_output', reason: 'line_length', lineLengths };
  }
  const allowedNumbers = new Set(source.refs.flatMap((ref) => String(ref.value).match(/\d+(?:\.\d+)?%?/gu) || []));
  // 今日背景锚点（节气/节日/赛事）注入的数字同样视为可引用：
  // 否则 prompt 鼓励的"还有 N 天"倒计时会因 N 不在 refs 里被 ungrounded_number 打回
  for (const number of opts.anchorNumbers || []) allowedNumbers.add(number);
  const unexpectedNumbers = [];
  for (const line of output.lines) {
    const numbers = line.match(/\d+(?:\.\d+)?%?/gu) || [];
    unexpectedNumbers.push(...numbers.filter((number) => !allowedNumbers.has(number)));
  }
  if (unexpectedNumbers.length) {
    return { ok: false, kind: 'invalid_output', reason: 'ungrounded_number', unexpectedNumbers };
  }
  // 反 AI 味量化校验（可关）：误伤不阻断服务，只触发重试
  if (opts.humanize !== false) {
    const ai = checkAiFlavor(output.lines);
    if (ai) {
      return { ok: false, kind: 'invalid_output', reason: 'ai_flavor', ai };
    }
  }
  const safeOutput = { lines: output.lines, emoji_caption: output.emoji_caption || '⭐️ 并肩前行，为无言加油！' };
  if (safeOutput.lines.some(isContentBlocked) || isContentBlocked(safeOutput.emoji_caption)) {
    return { ok: false, kind: 'blocked_content', reason: 'blocked_term' };
  }
  return { ok: true, output: safeOutput };
}

/**
 * 收集今日背景锚点（节气/节日/赛事）注入 prompt 的数字 + 事件剩余天数，
 * 供 ungrounded_number 校验纳入白名单。
 */
function collectAnchorNumbers(ctx) {
  const numbers = new Set();
  if (ctx && ctx.eventPhase) numbers.add(String(ctx.eventPhase.daysUntil));
  if (ctx && ctx.dateContext && Array.isArray(ctx.dateContext.anchors)) {
    for (const anchor of ctx.dateContext.anchors) {
      for (const number of String(anchor.text || '').match(/\d+(?:\.\d+)?%?/gu) || []) {
        numbers.add(number);
      }
    }
  }
  return [...numbers];
}

// ── 反 AI 味量化规则（humanize）──
const ABSTRACT_TERMS = ['梦想', '热爱', '永远', '信念', '一定'];
const PARALLEL_PATTERNS = [
  /不只(是)?[^，。！!]{2,8}[，,]\s*更(是)?/u,
  /既是[^，。！!]{2,10}[，,]\s*又是/u,
  /没有[^，。！!]{2,10}[，,]\s*只有/u,
];
const LEADING_PUNCT = /^[\s"'“”‘’《〈「『\[【(:：]+/u;

/** 返回首个命中的 AI 味规则，或 null */
function checkAiFlavor(lines) {
  const all = lines.join('\n');
  // 1. 连续感叹号（半角/全角）
  if (/!{2,}/u.test(all) || /！{2,}/u.test(all)) {
    return { rule: 'double_exclamation', detail: '连续感叹号' };
  }
  // 2. 感叹号密度（按条数等比放宽：CHEER_LINE_COUNT 条合计 > CHEER_LINE_COUNT 个拒绝）
  const exCount = (all.match(/!|！/gu) || []).length;
  if (exCount > CHEER_LINE_COUNT) {
    return { rule: 'exclamation_density', detail: `感叹号共 ${exCount} 个` };
  }
  // 3. 句首雷同（5 条中 2 条同开头属正常，任一组 ≥ 3 才拒绝）
  const starts = lines.map((l) => l.replace(LEADING_PUNCT, '').slice(0, 1));
  const seen = new Map();
  for (const s of starts) {
    if (!s) continue;
    const n = (seen.get(s) || 0) + 1;
    if (n >= 3) return { rule: 'same_opening', detail: `句首「${s}」出现 ${n} 次` };
    seen.set(s, n);
  }
  // 4. 抽象词堆叠（文本变长命中概率上升，不同抽象词命中 > 4 拒）
  const hitTerms = ABSTRACT_TERMS.filter((t) => all.includes(t));
  if (hitTerms.length > 4) {
    return { rule: 'abstract_terms', detail: `抽象词过多：${hitTerms.join('、')}` };
  }
  // 5. 排比三连句式
  for (const re of PARALLEL_PATTERNS) {
    if (re.test(all)) return { rule: 'parallel_pattern', detail: '排比句式' };
  }
  return null;
}

function buildRetryInstruction(failure) {
  if (failure.reason === 'line_length') {
    return `上一次 ${CHEER_LINE_COUNT} 条文案的字符数分别为 ${failure.lineLengths.join('、')}，请全部重新生成并确保每条至少 10 个字符，建议 30 至 50 个字符。不要解释，只输出指定 JSON。`;
  }
  if (failure.reason === 'ungrounded_number') {
    return '上一次输出包含未提供的数据。请全部重新生成，只能使用"可引用数据"中的数字；不要解释，只输出指定 JSON。';
  }
  if (failure.reason === 'ai_flavor') {
    const detail = (failure.ai && failure.ai.detail) || '句式雷同/口号化';
    return `上一次文案有 AI 腔（${detail}）。请全部重新生成：拆散句式、减少感叹号、让 ${CHEER_LINE_COUNT} 条文案的角度和开头都不一样、去掉口号式总结；不要解释，只输出指定 JSON。`;
  }
  if (failure.kind === 'blocked_content') {
    return '上一次输出未通过内容安全检查。请全部重新生成正常、积极的粉丝应援文案；不要解释，只输出指定 JSON。';
  }
  return `上一次输出格式不符合要求。请全部重新生成恰好 ${CHEER_LINE_COUNT} 条、每条至少 10 个字符的文案；不要解释，只输出指定 JSON。`;
}

async function consumeAiQuota({ subjectId, ipHash, requestId, date }) {
  const receiptId = `aiCheer_request_${hashValue(`${subjectId}:${requestId}`)}`;
  return runTransaction(async (tc) => {
    const col = tc('usage_limits');
    const receiptResult = await col.doc(receiptId).get();
    const receipt = receiptResult.data && receiptResult.data[0];
    if (receipt) return { allowed: true, receiptId, response: receipt.response || null };

    const limits = [
      { id: `aiCheer_user_${hashValue(subjectId)}_${date}`, limit: readLimit('AI_USER_DAILY_LIMIT', 10), dimension: 'user' },
      { id: `aiCheer_ip_${ipHash}_${date}`, limit: readLimit('AI_IP_DAILY_LIMIT', 30), dimension: 'ip' },
      { id: `aiCheer_global_${date}`, limit: readLimit('AI_GLOBAL_DAILY_LIMIT', 500), dimension: 'global' },
    ];

    const current = [];
    for (const item of limits) {
      const result = await col.doc(item.id).get();
      const doc = result.data && result.data[0];
      const count = Number((doc && doc.count) || 0);
      if (count >= item.limit) return { allowed: false, receiptId: '' };
      current.push({ ...item, count });
    }

    const now = new Date().toISOString();
    for (const item of current) {
      await col.doc(item.id).set({
        module: 'aiCheer', dimension: item.dimension, date, count: item.count + 1,
        limit: item.limit, updated_at: now,
      });
    }
    await col.doc(receiptId).set({
      module: 'aiCheerRequest', subject_id_hash: hashValue(subjectId, config.ipHashSalt),
      request_id: requestId, status: 'pending', created_at: now,
    });

    return { allowed: true, receiptId, response: null };
  });
}

async function markReceipt(receiptId, status) {
  if (!receiptId) return;
  try {
    const col = await collection('usage_limits');
    await col.doc(receiptId).update({ status, updated_at: new Date().toISOString() });
  } catch (_) { }
}

// ── 昨日赛事句式记忆（避免连续两天注入同一句式，形成新的公式化）──
const lastEventTextCache = new Map(); // subjectId -> { text, ts }
const LAST_EVENT_TEXT_TTL_MS = 5 * 60 * 1000;

async function getLastEventText(subjectId) {
  try {
    const cached = lastEventTextCache.get(subjectId);
    if (cached && Date.now() - cached.ts < LAST_EVENT_TEXT_TTL_MS) return cached.text;
    const col = await collection('ai_reports');
    const result = await col
      .where({ subject_id: subjectId, event_hit: { $exists: true } })
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    const doc = result.data && result.data[0];
    let text = null;
    if (doc) {
      const anchors = Array.isArray(doc.date_context)
        ? doc.date_context
        : (doc.date_context && Array.isArray(doc.date_context.anchors) ? doc.date_context.anchors : []);
      const eventAnchor = anchors.find((a) => a && a.kind === 'event' && a.text);
      if (eventAnchor) text = eventAnchor.text;
    }
    lastEventTextCache.set(subjectId, { text, ts: Date.now() });
    return text;
  } catch (_) {
    return null; // DB 不可用/查询失败时跳过避重逻辑，不影响主流程
  }
}

function readLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeSnapshotAt(value) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return '';
}

module.exports = router;

// ── 导出内部函数（供 CLI 脚本复用）──
module.exports.__test = {
  CHEER_LINE_COUNT,
  buildGroundedSource,
  buildSystemPrompt,
  buildUserPrompt,
  buildRetryInstruction,
  parseGeneratedText,
  inspectGeneratedOutput,
  checkAiFlavor,
  collectAnchorNumbers,
  getLatestOverview,
};
