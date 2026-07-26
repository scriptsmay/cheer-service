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
const {
  getRequestId, getClientIp, shanghaiDate, normalizeClientId,
  isValidClientId, normalizeRequestId, hashValue, formatRate,
  textLength, isObject, getErrorMessage,
} = require('../utils/helpers');
const config = require('../config/env');

const MAX_GENERATION_ATTEMPTS = 2;
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
    const overview = await getLatestOverview();
    const source = buildGroundedSource(overview);
    const idempotencyKey = normalizeRequestId(req.headers?.['x-request-id'] || requestId);
    const quota = await consumeAiQuota({
      subjectId: identity.subjectId,
      ipHash: hashValue(getClientIp(req), config.ipHashSalt),
      requestId: idempotencyKey,
      date: shanghaiDate().date,
    });

    if (!quota.allowed) return errorResponse(res, 429, 'RATE_LIMITED', '今日应援生成额度已用完', requestId, 86400);
    if (quota.response) return successResponse(res, quota.response, requestId);

    const generation = await generateValidatedOutput({ mood, text, source, requestId });
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
    await aiReportsCol.doc(reportId).set({
      report_id: reportId,
      module: 'aiCheer',
      status: 'active',
      subject_id: identity.subjectId,
      client_id_hash: hashValue(clientId, config.ipHashSalt),
      user_input: { mood, text_summary: text.slice(0, 40) },
      ai_output: safeOutput,
      refs: source.refs,
      source_snapshot_at: sourceSnapshotAt,
      timestamp: now.getTime(),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
    });

    const usageCol = await collection('usage_limits');
    await usageCol.doc(quota.receiptId).update({ status: 'success', response: payload, updated_at: now.toISOString() });

    return successResponse(res, payload, requestId);
  } catch (error) {
    console.error('[ai-cheer] request failed', { requestId, message: getErrorMessage(error) });
    return errorResponse(res, 503, 'WRITE_FAILED', '服务暂时不可用，请稍后重试', requestId);
  }
});

// ── 内部函数 ──

async function generateValidatedOutput({ mood, text, source, requestId }) {
  let lastFailure = { kind: 'invalid_output', reason: 'not_generated' };
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const messages = [
      { role: 'system', content: buildSystemPrompt(mood, source) },
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

    const validation = inspectGeneratedOutput(parseGeneratedText(result && result.text), source);
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

function buildGroundedSource(overview) {
  if (!overview) return { refs: [], snapshotAt: '', promptLines: [] };
  const envelope = isObject(overview.data) ? overview.data : {};
  const data = isObject(envelope.data) ? envelope.data : envelope;
  const seasonId = typeof overview.season === 'string' ? overview.season : '';
  const seasonStats = Array.isArray(data.season_stats) ? data.season_stats.find((item) => isObject(item) && item.season_id === seasonId) : null;
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
  const heroSummary = heroes.filter((item) => isObject(item) && typeof item.hero_name === 'string' && item.hero_name).slice(0, 5).map(formatHeroSummary).join('、');
  addRef(refs, '常用英雄（按出场数）', heroSummary, 'season_summaries');
  // 只保留前 6 条数据，避免 prompt 太长
  const trimmedRefs = refs.slice(0, 6);
  return { refs: trimmedRefs, promptLines: trimmedRefs.map((r) => `${r.label}：${r.value}`), snapshotAt: normalizeSnapshotAt(overview.updated_at || overview.source_snapshot_at) };
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

只允许引用下方"可引用数据"中明确提供的具体数字、百分比和英雄名；没有提供的数据不得猜测或补充。数据按语境自然选用即可，不要为了塞数据牺牲口语感。三条文案中最多两条引用数据，至少一条完全不引用数据、只表达自然情绪。
所有数字必须使用阿拉伯数字（如 4.29、56.7%、28局），禁止使用中文数字（如四點二九、五十六点七、二十八局）。

必须输出 3 条中文短句，每条建议 30 至 50 字且不得少于 10 字；另输出一句简短的 emoji_caption。emoji_caption 也要自然，不要复述短句。

不得使用传统球类运动词汇，不得声称单场 MVP、本周表现或未提供的赛程结果。

参考自然程度，不要照抄：
- 今天也期待你的下一次亮相。
- 慢慢找回节奏，我们一直都在。
- 热爱不会缺席，放开手去拼！
`;

function buildSystemPrompt(mood, source) {
  return [
    DEFAULT_PROMPT,
    `语气：${MOOD_PROMPTS[mood]}`,
    `可引用数据：${source.promptLines.length ? source.promptLines.join('；') : '无，生成纯情绪应援文案'}`,
    '只输出合法 JSON，lines 必须恰好包含 3 个字符串：{"lines":["文案1","文案2","文案3"],"emoji_caption":"配文"}',
  ].join('\n');
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

function inspectGeneratedOutput(output, source) {
  if (!output || !Array.isArray(output.lines) || output.lines.length !== 3) {
    return { ok: false, kind: 'invalid_output', reason: 'line_count' };
  }
  const lineLengths = output.lines.map(textLength);
  if (output.lines.some((line, index) => !line || lineLengths[index] < 10)) {
    return { ok: false, kind: 'invalid_output', reason: 'line_length', lineLengths };
  }
  const allowedNumbers = new Set(source.refs.flatMap((ref) => String(ref.value).match(/\d+(?:\.\d+)?%?/gu) || []));
  const unexpectedNumbers = [];
  for (const line of output.lines) {
    const numbers = line.match(/\d+(?:\.\d+)?%?/gu) || [];
    unexpectedNumbers.push(...numbers.filter((number) => !allowedNumbers.has(number)));
  }
  if (unexpectedNumbers.length) {
    return { ok: false, kind: 'invalid_output', reason: 'ungrounded_number', unexpectedNumbers };
  }
  const safeOutput = { lines: output.lines, emoji_caption: output.emoji_caption || '⭐️ 并肩前行，为无言加油！' };
  if (safeOutput.lines.some(isContentBlocked) || isContentBlocked(safeOutput.emoji_caption)) {
    return { ok: false, kind: 'blocked_content', reason: 'blocked_term' };
  }
  return { ok: true, output: safeOutput };
}

function buildRetryInstruction(failure) {
  if (failure.reason === 'line_length') {
    return `上一次三条文案的字符数分别为 ${failure.lineLengths.join('、')}，请全部重新生成并确保每条至少 10 个字符，建议 30 至 50 个字符。不要解释，只输出指定 JSON。`;
  }
  if (failure.reason === 'ungrounded_number') {
    return '上一次输出包含未提供的数据。请全部重新生成，只能使用"可引用数据"中的数字；不要解释，只输出指定 JSON。';
  }
  if (failure.kind === 'blocked_content') {
    return '上一次输出未通过内容安全检查。请全部重新生成正常、积极的粉丝应援文案；不要解释，只输出指定 JSON。';
  }
  return '上一次输出格式不符合要求。请全部重新生成恰好 3 条、每条至少 10 个字符的文案；不要解释，只输出指定 JSON。';
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
  buildGroundedSource,
  buildSystemPrompt,
  buildUserPrompt,
  parseGeneratedText,
  inspectGeneratedOutput,
  getLatestOverview,
};
