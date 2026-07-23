'use strict';

/**
 * ask 路由 — ← ask
 * AI 小秘书问答
 */

const express = require('express');
const crypto = require('crypto');
const { collection, runTransaction } = require('../db/mongo');
const { generateText } = require('../services/ai');
const { resolveIdentity } = require('../services/identity');
const { successResponse, errorResponse } = require('../services/response');
const { isContentBlocked } = require('../lib/ai-utils');
const { getRequestId, getBjDate, formatBjTime, positiveInt, BJ_OFFSET } = require('../utils/helpers');

const CACHE_TTL = 5 * 60 * 1000;

const router = express.Router();

router.post('/', async (req, res) => {
  const requestId = getRequestId(req);

  const identity = await resolveIdentity(req);
  if (!identity.ok) return errorResponse(res, 401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId);

  const body = req.body || {};
  const query = req.query || {};
  const q = (body.q || query.q || '').trim();
  if (!q) return errorResponse(res, 400, 'INVALID_ARGUMENT', '问题不能为空', requestId);
  if (Array.from(q).length > 200) return errorResponse(res, 400, 'INVALID_ARGUMENT', '问题不能超过 200 个字符', requestId);
  if (isContentBlocked(q)) return errorResponse(res, 451, 'CONTENT_BLOCKED', '问题内容未通过安全检查', requestId);

  try {
    const cacheKey = md5(normalize(q));
    const cached = await getCache(cacheKey);
    if (cached) {
      await recordUsage('ask', 'cache');
      return successResponse(res, cached, requestId);
    }

    const { overviewData, liveData, scheduleData, refs } = await fetchContextData();
    if (!overviewData) return errorResponse(res, 404, 'NOT_FOUND', '暂无相关数据', requestId);

    const dailyLimit = await getDailyLimit('ask');
    const limitOk = await checkUsageLimit('ask', dailyLimit, identity.subjectId, requestId);
    if (!limitOk) return errorResponse(res, 429, 'RATE_LIMITED', '今日 AI 调用已达上限，请明日再来', requestId, 86400);

    const systemPrompt = buildSystemPrompt(overviewData);
    const userPrompt = buildUserPrompt(q, overviewData, liveData, scheduleData);

    let answer = '';
    try {
      answer = await callAI(systemPrompt, userPrompt);
    } catch (aiErr) {
      console.error('[ask] AI call failed:', aiErr.message);
      await recordAIReport('ask', identity.subjectId, q, '', aiErr.message);
      return errorResponse(res, 503, 'AI_UNAVAILABLE', '小秘书暂时开小差，稍后再试～', requestId);
    }

    const result = { answer, refs };
    if (isContentBlocked(answer)) {
      console.warn('[ask] AI answer blocked by content safety');
      await recordAIReport('ask', identity.subjectId, q, 'BLOCKED: ' + answer, 'content_blocked');
      return errorResponse(res, 451, 'CONTENT_BLOCKED', '回答内容未通过安全检查，请换个方式提问', requestId);
    }

    await setCache(cacheKey, q, normalize(q), result);
    await recordUsage('ask', 'ai');
    await recordAIReport('ask', identity.subjectId, q, answer, '');

    return successResponse(res, result, requestId);
  } catch (err) {
    console.error('[ask] Error:', err.message, err.stack);
    return errorResponse(res, 503, 'WRITE_FAILED', '服务暂时不可用，请稍后重试', requestId);
  }
});

// ── 内部函数 ──

function normalize(q) {
  return q.toLowerCase().replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').replace(/\s+/g, '');
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

async function getCache(cacheKey) {
  try {
    const col = await collection('ask_cache');
    const res = await col.doc(cacheKey).get();
    if (res.data && res.data.length > 0) {
      const doc = res.data[0];
      if (doc.expires_at > Date.now()) return { answer: doc.answer, refs: doc.refs || [] };
      await col.doc(cacheKey).remove();
    }
  } catch (_) {}
  return null;
}

async function setCache(cacheKey, q, normalizedQ, result) {
  try {
    const now = Date.now();
    const col = await collection('ask_cache');
    await col.doc(cacheKey).set({
      q, normalized_q: normalizedQ, answer: result.answer,
      refs: result.refs || [], created_at: now, expires_at: now + CACHE_TTL,
    });
  } catch (e) {
    console.warn('[ask] cache set failed:', e.message);
  }
}

async function fetchContextData() {
  const refs = [];
  let overviewData = null, liveData = null, scheduleData = null;

  try {
    const col = await collection('season_summaries');
    const ovRes = await col.orderBy('updated_at', 'desc').limit(1).get();
    if (ovRes.data.length > 0) {
      overviewData = ovRes.data[0];
      refs.push('当前赛季概览');
    }
  } catch (e) { console.warn('[ask] fetch overview failed:', e.message); }

  try {
    const nowBj = getBjDate();
    const year = nowBj.getUTCFullYear();
    const month = nowBj.getUTCMonth() + 1;
    const col = await collection('live_streams');
    const liveRes = await col.where({ year, month }).get();
    const streams = (liveRes.data || []).filter((s) => s.type !== 'monthly_summary');
    if (streams.length > 0) {
      const totalHours = Math.round(streams.reduce((s, x) => s + (x.duration || 0), 0) / 360) / 10;
      liveData = { month: `${year}-${String(month).padStart(2, '0')}`, total_sessions: streams.length, total_hours: totalHours, latest_date: streams[0].stream_date };
      refs.push('本月直播数据');
    }
  } catch (e) { console.warn('[ask] fetch live failed:', e.message); }

  try {
    const col = await collection('match_schedules');
    const schedRes = await col.orderBy('updated_at', 'desc').limit(1).get();
    if (schedRes.data.length > 0) {
      const doc = schedRes.data[0];
      const matches = doc.matches || [];
      const nowTs = Math.floor(Date.now() / 1000);
      const todayBj = getBjDate(); todayBj.setUTCHours(0, 0, 0, 0);
      const todayStartTs = Math.floor(todayBj.getTime() / 1000) - BJ_OFFSET / 1000;
      const todayEndTs = todayStartTs + 86400;
      const todayMatches = matches.filter((m) => m.start_ts >= todayStartTs && m.start_ts < todayEndTs);
      const upcoming = matches.filter((m) => m.start_ts >= nowTs).slice(0, 5);
      const recent = matches.filter((m) => m.start_ts > 0 && m.start_ts < nowTs).slice(-5).reverse();
      const fmt = (m) => { const dateStr = formatBjTime(m.start_ts); const score = m.status === 4 ? ` ${m.score_a}:${m.score_b}` : ''; return `${dateStr} ${m.team_a} vs ${m.team_b}${score} (${m.stage || m.date})`; };
      if (upcoming.length || recent.length || todayMatches.length) {
        scheduleData = { season_name: doc.season_name, today: todayMatches.map(fmt), upcoming: upcoming.map(fmt), recent: recent.map(fmt) };
        refs.push('赛程数据');
      }
    }
  } catch (e) { console.warn('[ask] fetch schedule failed:', e.message); }

  return { overviewData, liveData, scheduleData, refs };
}

function buildSystemPrompt(overview) {
  const player = overview.player_name || '无言';
  const team = overview.team_name || '';
  return `你是${player}的贴身小秘书，语气亲切活泼，带粉圈感。
你只基于下面提供的 JSON 数据回答问题，数据中没有的内容要明确说"暂无相关数据"，绝对不能编造数据。
回答要简短自然，用口语化的中文，不要太正式。
当前选手：${player}，所属战队：${team}。`;
}

function buildUserPrompt(q, overview, live, schedule) {
  const rawData = overview.data || {};
  const data = rawData.data || rawData;
  const seasonId = overview.season || '';
  const seasonName = overview.season_name || seasonId;
  const career = data.career_summary || {};
  const seasonStatsArr = data.season_stats || [];
  const seasonStats = seasonStatsArr.find((s) => s.season_id === seasonId) || {};
  const heroStats = data.hero_stats || [];

  const fmtRate = (v) => {
    if (v == null) return '暂无';
    if (typeof v === 'string') { if (v.includes('%')) return v; const n = parseFloat(v); if (!isNaN(n) && n <= 1) return (n * 100).toFixed(1) + '%'; return v; }
    if (typeof v === 'number') { if (v <= 1) return (v * 100).toFixed(1) + '%'; return v.toFixed(1) + '%'; }
    return String(v);
  };

  const winRate = seasonStats.win_rate != null ? fmtRate(seasonStats.win_rate) : fmtRate(career.win_rate);
  const kda = seasonStats.kda_ratio != null ? seasonStats.kda_ratio : '暂无';
  const totalMatches = seasonStats.battles != null ? seasonStats.battles : career.total_matches || '暂无';
  const mvp = seasonStats.mvp != null ? seasonStats.mvp : '暂无';

  const heroTopStr = heroStats.slice(0, 5).map((h) => `${h.hero_name}(${fmtRate(h.win_rate)}, ${h.battles}场)`).join('、');

  let context = `【赛季概览 - ${seasonName}】\n战队: ${overview.team_name || ''}\n胜率: ${winRate}\nKDA: ${kda}\n总场次: ${totalMatches}\nMVP次数: ${mvp}\n常用英雄Top5: ${heroTopStr || '暂无'}`;
  if (live) context += `\n\n【本月直播数据 - ${live.month}】\n直播天数: ${live.total_sessions}天\n总时长: ${live.total_hours}小时\n最近直播: ${live.latest_date}`;
  if (schedule) {
    context += `\n\n【赛程数据 - ${schedule.season_name}】`;
    if (schedule.today?.length) context += `\n今日比赛:\n${schedule.today.join('\n')}`;
    if (schedule.upcoming?.length) context += `\n即将开始的比赛:\n${schedule.upcoming.join('\n')}`;
    if (schedule.recent?.length) context += `\n最近已完赛的比赛:\n${schedule.recent.join('\n')}`;
    if (!schedule.upcoming?.length && !schedule.recent?.length && !schedule.today?.length) context += '\n暂无赛程信息';
  }
  context += `\n\n用户问题：${q}\n请基于以上数据回答，数据中没有的就说"暂无相关数据"。`;
  return context;
}

async function callAI(systemPrompt, userPrompt) {
  const res = await generateText({ messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.75 });
  if (res?.usage) console.log('[ask] AI tokens used:', res.usage.total_tokens);
  if (res?.text) return res.text;
  throw new Error('AI response format unexpected');
}

async function getDailyLimit(module) {
  const defaultLimit = 10;
  try {
    const col = await collection('app_config');
    const res = await col.doc('ai_limits').get();
    if (res.data?.[0]) {
      const doc = res.data[0];
      if (module === 'ask') return positiveInt(doc.ask_daily_limit, defaultLimit);
      if (module === 'aiCheer') return positiveInt(doc.cheer_daily_limit, defaultLimit);
    }
  } catch (e) { console.warn('[ask] getDailyLimit failed, using default:', e.message); }
  return defaultLimit;
}

async function checkUsageLimit(module, dailyLimit, subjectId, requestId) {
  const bjNow = getBjDate();
  const y = bjNow.getUTCFullYear();
  const m = String(bjNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bjNow.getUTCDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  const subjectHash = crypto.createHash('sha256').update(String(subjectId)).digest('hex');
  const docId = `${module}_user_${subjectHash}_${today}`;
  const receiptId = `${module}_request_${crypto.createHash('sha256').update(`${subjectId}:${requestId}`).digest('hex')}`;
  try {
    return await runTransaction(async (tc) => {
      const col = tc('usage_limits');
      const receiptResult = await col.doc(receiptId).get();
      if (receiptResult.data?.length) return true;
      const result = await col.doc(docId).get();
      const doc = result.data?.[0];
      const count = Number((doc && doc.count) || 0);
      if (count >= dailyLimit) return false;
      const now = new Date().toISOString();
      await col.doc(docId).set({ module, dimension: 'user', date: today, count: count + 1, limit: dailyLimit, updated_at: now });
      await col.doc(receiptId).set({ module: `${module}Request`, request_id: requestId, subject_id_hash: subjectHash, created_at: now });
      return true;
    });
  } catch (e) {
    console.error('[ask] usage limit check failed:', e.message);
    throw e;
  }
}

async function recordUsage(_module, _source) { return true; }

async function recordAIReport(module, subjectId, userInput, aiOutput, error) {
  try {
    const now = new Date();
    const reportId = crypto.randomUUID();
    const col = await collection('ai_reports');
    await col.doc(reportId).set({
      report_id: reportId, module, status: 'active', subject_id: subjectId,
      user_input: userInput, ai_output: aiOutput, error: error || null,
      timestamp: now.getTime(), created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (e) { console.warn('[ask] ai report failed:', e.message); }
}

module.exports = router;
