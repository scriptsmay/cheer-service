'use strict';

/**
 * cheer 路由 — ← ai-cheer
 * AI 应援文案生成
 */

const express = require('express');
const { randomUUID } = require('node:crypto');
const { collection, runTransaction, command } = require('../db/mongo');
const { generateText } = require('../services/ai');
const { resolveIdentity } = require('../services/identity');
const { successResponse, errorResponse } = require('../services/response');
const { isContentBlocked } = require('../lib/ai-utils');
const { getCheerSettings, getActiveEventsForDate } = require('../services/settings-store');
const { getDateContext } = require('../lib/date-context');
const { renderTemplate, DEFAULT_PROMPTS } = require('../lib/prompt-template');
const {
  getRequestId, getClientIp, shanghaiDate, normalizeClientId,
  isValidClientId, normalizeRequestId, hashValue, formatRate,
  textLength, isObject, getErrorMessage,
} = require('../utils/helpers');
const config = require('../config/env');

// 单次生成条数（单一事实来源：prompt / 校验 / 重试文案均由此动态拼装）
const CHEER_LINE_COUNT = 5;
// 每条字数硬下限（prompt 锚点；校验层 line_length 仍以 10 字兜底，不新增拒绝路径）
const CHEER_LINE_MIN_CHARS = 20;
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

// ── 5 条角色分工（v1.1.0 Task 5 反重复）：按天轮换组合，同一档同型、隔天不同 ──
// 池中角色可被上下文裁剪：赛事倒数/轻提仅在事件命中时入池；生涯数据仅在可引数据非空时入池
const CHEER_ROLES = [
  { key: 'daily', label: '日常陪伴' },
  { key: 'event', label: '赛事倒数' },   // preview 期动态替换为「赛事轻提」
  { key: 'memory', label: '回忆杀' },
  { key: 'ask', label: '互动提问' },
  { key: 'hype', label: '应援口号' },
  { key: 'stats', label: '生涯数据' },
];

/**
 * 按日期种子给本组文案分配角色：同一日期结果稳定，隔天组合不同。
 * @param {{dateStr:string, lineCount:number, hasEvent:boolean, isPreview:boolean, hasStats:boolean}} opts
 * @returns {string[]} 长度为 lineCount 的角色标签序列（第 i 条承担第 i 个角色）
 */
function assignRoles({ dateStr, lineCount, hasEvent, isPreview, hasStats }) {
  const pool = CHEER_ROLES
    .filter((role) => {
      if (role.key === 'event') return hasEvent;
      if (role.key === 'stats') return hasStats;
      return true;
    })
    .map((role) => (role.key === 'event' && isPreview ? { ...role, label: '赛事轻提' } : role));
  if (!pool.length) return [];
  // 种子 = 日期数字：同一天稳定，隔天位移不同（YYYYMMDD 连续日期模长不同）
  const seed = Number(String(dateStr || '').replace(/-/gu, '')) || 0;
  const rotated = [...pool.slice(seed % pool.length), ...pool.slice(0, seed % pool.length)];
  const roles = [];
  for (let i = 0; i < lineCount; i += 1) roles.push(rotated[i % rotated.length].label);
  return roles;
}

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
    // 反重复·历史指纹（v1.1.0 Task 4）：近 14 天成功输出开头 → 注入避开列表（近 7 天去重前 10）+ 校验层拒绝重复
    const recentOpenings = await getRecentOpenings(identity.subjectId, 14);

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

    const ctx = { dateContext, eventHit, eventPhase, humanizeEnabled, prompts: settings.prompts, recentOpenings, date: todayStr };
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
    // 提示词版本追溯（v1.1.0）：0 = 代码默认，≥1 = 后台自定义版本（可归因/可回滚）
    reportDoc.prompt_version = settings.prompts ? settings.prompts.version || 0 : 0;
    // 反重复可观测性（v1.1.0）：本组角色分工与多候选模式，供重复率周报统计角色覆盖率
    if (generation.roles) reportDoc.roles = generation.roles;
    if (generation.candidates > 1) reportDoc.candidate_count = generation.candidates;
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
  // 生效提示词配置：校验/重试口径与 prompt 同源（后台改条数后整链路一致）
  const promptCfg = ctx && ctx.prompts && typeof ctx.prompts === 'object' ? ctx.prompts : DEFAULT_PROMPTS;
  // 近 14 天开头指纹去重集合（校验用）；注入列表在 buildSystemPrompt 内另取近 7 天前 10 条
  const recentOpeningSet = Array.from(new Set(((ctx && ctx.recentOpenings) || []).map((entry) => entry.opening)));
  // 角色分工（v1.1.0 Task 5）：按日期轮换 + 档位/数据裁剪，重试时保持同一组角色不变
  const roles = assignRoles({
    dateStr: (ctx && ctx.date) || shanghaiDate().date,
    lineCount: Number.isInteger(promptCfg.line_count) ? promptCfg.line_count : CHEER_LINE_COUNT,
    hasEvent: Boolean(ctx && ctx.eventHit && ctx.eventPhase),
    isPreview: Boolean(ctx && ctx.eventPhase && ctx.eventPhase.phase === 'preview'),
    hasStats: Array.isArray(source.refs) && source.refs.length > 0,
  });
  let lastFailure = { kind: 'invalid_output', reason: 'not_generated' };
  // 多候选（v1.1.0 Task 6，默认 1）：单次尝试内生成 N 个候选，首个通过校验者胜出（成本 ×N，免费期零负担）
  const candidateCount = Number.isInteger(promptCfg.candidate_count) && promptCfg.candidate_count >= 1
    ? Math.min(promptCfg.candidate_count, 3) : 1;
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const messages = [
      { role: 'system', content: buildSystemPrompt(mood, source, mode, ctx) },
      { role: 'user', content: buildUserPrompt(mood, text, source, roles) },
    ];
    if (attempt > 1) messages.push({ role: 'user', content: buildRetryInstruction(lastFailure, promptCfg) });

    const candidateResults = [];
    for (let c = 0; c < candidateCount; c += 1) {
      try {
        candidateResults.push(await generateText({
          messages,
          temperature: 0.85,
          jsonMode: true,
          frequency_penalty: promptCfg.frequency_penalty,
          presence_penalty: promptCfg.presence_penalty,
        }));
      } catch (error) {
        lastFailure = { kind: 'model_error', reason: getErrorMessage(error) };
        console.warn('[ai-cheer] model attempt failed', { requestId, attempt, candidate: c + 1, message: lastFailure.reason });
      }
    }
    if (!candidateResults.length) continue; // 全部候选模型错误，进入下一次重试

    let attemptFailure = null;
    for (const result of candidateResults) {
      const validation = inspectGeneratedOutput(parseGeneratedText(result && result.text), source, {
        humanize: !ctx || ctx.humanizeEnabled !== false,
        anchorNumbers: collectAnchorNumbers(ctx),
        line_count: promptCfg.line_count,
        recentOpenings: recentOpeningSet,
      });
      console.log('[ai-cheer] model completed', { requestId, attempt, totalTokens: result?.usage?.total_tokens });
      if (validation.ok) return { ok: true, output: validation.output, roles, candidates: candidateCount };
      attemptFailure = validation;
      console.warn('[ai-cheer] output rejected', { requestId, attempt, reason: validation.reason });
    }
    lastFailure = attemptFailure || lastFailure;
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

必须输出 {{line_count}} 条中文短句，每条必须不少于 {{line_min_chars}} 个字，并尽量写到 30 至 50 字；另输出一句简短的 emoji_caption。emoji_caption 也要自然，不要复述短句。

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
// 留代码红线：措辞不可后台改，但条数口径随生效配置动态渲染，防条数调整后文案漂移
const HUMANIZE_GUIDE = `
避免 AI 腔：禁止排比三连句式（"不只是…更是…"）、禁止连续感叹号（最多一个）、禁止抽象词堆叠（梦想/热爱/永远/信念 每词整次输出最多一次）、禁止句式同构（{{line_count}} 条文案开头雷同）、禁止口号式收尾（每句都是正能量总结）。
像粉丝真的在打字：有停顿、有细节、允许一点点随意，不要每句都像精心设计的金句。
`;

// 三档事件提示模板默认值已迁移至 prompt-template.js DEFAULT_PROMPTS（v1.1.0 配置化：
// 措辞进后台 cheer_settings.prompts，占位符渲染走 renderTemplate 单点，删配置即回默认）

function buildSystemPrompt(mood, source, mode = 'season', ctx = {}) {
  const isOffseason = mode === 'career' || mode === 'emotion';
  const moodPrompts = isOffseason ? MOOD_PROMPTS_OFFSEASON : MOOD_PROMPTS;
  // 生效提示词配置（后台可改，含代码默认回退）；条数/字数口径与校验层同源
  const promptCfg = ctx.prompts && typeof ctx.prompts === 'object' ? ctx.prompts : DEFAULT_PROMPTS;
  const lineCount = Number.isInteger(promptCfg.line_count) ? promptCfg.line_count : CHEER_LINE_COUNT;
  const lineMinChars = Number.isInteger(promptCfg.line_min_chars) ? promptCfg.line_min_chars : CHEER_LINE_MIN_CHARS;
  const renderVars = { line_count: lineCount, line_min_chars: lineMinChars };
  const parts = [renderTemplate(DEFAULT_PROMPT, renderVars).text];
  if (isOffseason) {
    // 事件命中（国家赛事）时用「正向替换」的豁免版约束，保留 KPL 禁令但放行亚运表述
    parts.push(ctx.eventHit ? OFFSEASON_CONSTRAINT_ASIAN_GAMES : OFFSEASON_CONSTRAINT);
  }
  if (ctx.humanizeEnabled !== false) parts.push(renderTemplate(HUMANIZE_GUIDE, renderVars).text);
  if (Array.isArray(promptCfg.few_shot_examples) && promptCfg.few_shot_examples.length) {
    // few-shot 示例池（后台标定，0-20 条）：仅语气与角度参考，禁止照抄
    parts.push(`参考示例（仅语气与角度参考，禁止照抄原文与其中数字）：\n${promptCfg.few_shot_examples.map((s) => `- ${s}`).join('\n')}`);
  }
  // 历史开头避开列表（v1.1.0 Task 4）：近 7 天去重前 10 条，防模型失忆重复起笔
  const recentOpeningsList = dedupeOpenings(ctx.recentOpenings);
  if (recentOpeningsList.length) {
    parts.push(`以下开头最近用过，请避开（换角度起笔，不要只在开头换几个字）：\n${recentOpeningsList.map((s) => `- ${s}`).join('\n')}`);
  }
  if (ctx.dateContext) {
    // 事件提示三档映射（v1.1.0）：倒数/临场/当天 → 强必含；预热 preview → 轻提软必含；无事件 → 通用软提示
    const phaseName = ctx.eventHit && ctx.eventPhase ? ctx.eventPhase.phase : null;
    const isStrong = Boolean(phaseName && ['countdown', 'eve', 'today'].includes(phaseName));
    const isPreview = phaseName === 'preview';
    const template = isStrong
      ? promptCfg.event_strong_hint
      : (isPreview ? promptCfg.event_preview_hint : promptCfg.date_context_hint);
    const eventMinLines = isStrong
      ? promptCfg.event_min_lines_strong
      : (isPreview ? promptCfg.event_min_lines_preview : 0);
    const eventAnchor = ctx.dateContext.anchors.find((a) => a.kind === 'event');
    const rendered = renderTemplate(template, {
      ...renderVars,
      event_min_lines: eventMinLines,
      event_text: eventAnchor ? eventAnchor.text : '',
      date_label: ctx.dateContext.dateLabel,
      anchors_text: ctx.dateContext.anchors.map((a) => a.text).join('；'),
      recent_openings: recentOpeningsList.join('、'),
    });
    // 渲染残留（占位符打错）时回退模板原文：保存层已拦截，运行时双保险
    parts.push(
      `今日背景：${ctx.dateContext.dateLabel}，${ctx.dateContext.anchors.map((a) => a.text).join('；')}\n${rendered.ok ? rendered.text : template}`
    );
  }
  parts.push(`语气：${moodPrompts[mood]}`);
  parts.push(`可引用数据：${source.promptLines.length ? source.promptLines.join('；') : '无，生成纯情绪应援文案'}`);
  const jsonExample = `{"lines":[${Array.from({ length: lineCount }, (_, i) => `"文案${i + 1}"`).join(',')}],"emoji_caption":"配文"}`;
  // 长度要求写进末尾指令行：模型对靠近输出位置的指令更敏感（扩条数后出现"总量守恒、每条变短"的压缩行为）
  parts.push(`只输出合法 JSON，lines 必须恰好包含 ${lineCount} 个字符串、每条不少于 ${lineMinChars} 个字：${jsonExample}`);
  return parts.join('\n');
}

function buildUserPrompt(mood, text, source, roles = []) {
  const lines = [`心情：${MOOD_NAMES[mood]}`, `数据条目数：${source.refs.length}`];
  if (text) lines.push(`用户补充：${text}`);
  if (roles.length) {
    lines.push(`本组 ${roles.length} 条文案分别承担：${roles.join('；')}。每条聚焦自己的角色展开，角度不要互相重合。`);
  }
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
  // 条数口径与提示词配置同源（后台改条数后校验层同步生效）；硬下限 10 字留代码红线
  const lineCount = Number.isInteger(opts.line_count) && opts.line_count > 0 ? opts.line_count : CHEER_LINE_COUNT;
  if (!output || !Array.isArray(output.lines) || output.lines.length !== lineCount) {
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
  // 历史开头指纹查重（v1.1.0 Task 4）：与近 14 天任一输出开头 8 字重复 → 拒绝并重试
  if (Array.isArray(opts.recentOpenings) && opts.recentOpenings.length) {
    const opening = extractOpening(output.lines);
    if (opening && opts.recentOpenings.includes(opening)) {
      return { ok: false, kind: 'invalid_output', reason: 'repeat_opening', opening };
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

function buildRetryInstruction(failure, promptCfg = {}) {
  const lineCount = Number.isInteger(promptCfg.line_count) ? promptCfg.line_count : CHEER_LINE_COUNT;
  const lineMinChars = Number.isInteger(promptCfg.line_min_chars) ? promptCfg.line_min_chars : CHEER_LINE_MIN_CHARS;
  if (failure.reason === 'line_length') {
    return `上一次 ${lineCount} 条文案的字符数分别为 ${failure.lineLengths.join('、')}，请全部重新生成并确保每条不少于 ${lineMinChars} 个字、尽量写到 30 至 50 个字。不要解释，只输出指定 JSON。`;
  }
  if (failure.reason === 'ungrounded_number') {
    return '上一次输出包含未提供的数据。请全部重新生成，只能使用"可引用数据"中的数字；不要解释，只输出指定 JSON。';
  }
  if (failure.reason === 'ai_flavor') {
    const detail = (failure.ai && failure.ai.detail) || '句式雷同/口号化';
    return `上一次文案有 AI 腔（${detail}）。请全部重新生成：拆散句式、减少感叹号、让 ${lineCount} 条文案的角度和开头都不一样、每条不少于 ${lineMinChars} 个字、去掉口号式总结；不要解释，只输出指定 JSON。`;
  }
  if (failure.reason === 'repeat_opening') {
    return `上一次文案的开头「${failure.opening || '…'}」与最近用过的开头重复。请全部重新生成，换一个全新的角度与开头起笔（不要只在原开头换几个字）；不要解释，只输出指定 JSON。`;
  }
  if (failure.kind === 'blocked_content') {
    return '上一次输出未通过内容安全检查。请全部重新生成正常、积极的粉丝应援文案；不要解释，只输出指定 JSON。';
  }
  return `上一次输出格式不符合要求。请全部重新生成恰好 ${lineCount} 条、每条不少于 ${lineMinChars} 个字的文案；不要解释，只输出指定 JSON。`;
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

// ── 历史开头指纹（v1.1.0 Task 4 反重复）：注入避开列表 + 校验层拒绝重复开头 ──
const OPENING_CHARS = 8;                 // 开头指纹长度（前 8 字）
const RECENT_OPENINGS_INJECT_LIMIT = 10; // 注入 prompt 的开头列表上限，防 prompt 膨胀

/**
 * 提取一组文案的开头指纹：首行去前导标点后取前 8 字；首行过短（< 4 字）不作为指纹。
 * @param {string[]} lines 生成的文案条目
 * @returns {string} 开头指纹（可能为空串）
 */
function extractOpening(lines) {
  const first = Array.isArray(lines) ? lines.find((line) => typeof line === 'string' && line.trim()) : '';
  if (!first) return '';
  const normalized = first.replace(LEADING_PUNCT, '').trim();
  return normalized.length >= 4 ? normalized.slice(0, OPENING_CHARS) : '';
}

/**
 * 取最近 N 天成功输出的开头指纹（按创建时间倒序）。
 * DB 不可用/查询失败时返回空数组，不影响主流程。
 * @param {string} subjectId 用户主体
 * @param {number} [days=14] 回溯天数
 * @returns {Promise<Array<{opening: string, created_at: string}>>}
 */
async function getRecentOpenings(subjectId, days = 14) {
  try {
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
    const col = await collection('ai_reports');
    const result = await col
      .where({ subject_id: subjectId, module: 'aiCheer', created_at: command.gte(cutoff) })
      .orderBy('created_at', 'desc')
      .limit(50)
      .get();
    const openings = [];
    for (const doc of result.data || []) {
      const opening = extractOpening(doc.ai_output && doc.ai_output.lines);
      if (opening) openings.push({ opening, created_at: doc.created_at });
    }
    return openings;
  } catch (_) {
    return []; // DB 不可用时跳过反重复，不影响主流程
  }
}

/** 去重聚合：最新优先，上限 limit 条（注入用 10 条防 prompt 膨胀） */
function dedupeOpenings(entries, limit = RECENT_OPENINGS_INJECT_LIMIT) {
  const seen = new Set();
  const list = [];
  for (const entry of entries || []) {
    const opening = entry && entry.opening;
    if (!opening || seen.has(opening)) continue;
    seen.add(opening);
    list.push(opening);
    if (list.length >= limit) break;
  }
  return list;
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
  CHEER_LINE_MIN_CHARS,
  buildGroundedSource,
  buildSystemPrompt,
  buildUserPrompt,
  buildRetryInstruction,
  parseGeneratedText,
  inspectGeneratedOutput,
  checkAiFlavor,
  collectAnchorNumbers,
  getLatestOverview,
  extractOpening,
  dedupeOpenings,
  getRecentOpenings,
  assignRoles,
};
