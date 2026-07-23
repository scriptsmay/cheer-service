'use strict';

/**
 * checkin 路由 — ← checkin (多路由)
 * 打卡系统：创建、查询、统计
 */

const express = require('express');
const { collection, runTransaction } = require('../db/mongo');
const { resolveIdentity } = require('../services/identity');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId, getClientIp, shanghaiDate, normalizeClientId, isValidClientId, hashValue } = require('../utils/helpers');
const { makeCheckinId, computeCheckinSummary } = require('../utils/checkin-summary');
const config = require('../config/env');

const router = express.Router();

// GET /stats — 当日全局打卡统计（无需鉴权）
router.get('/stats', async (req, res) => {
  const requestId = getRequestId(req);
  try {
    const date = shanghaiDate().date;
    const col = await collection('checkin_daily_stats');
    const result = await col.doc(date).get();
    const doc = result.data && result.data[0];
    return successResponse(res, {
      date,
      today_count: Number((doc && doc.count) || 0),
      updated_at: (doc && doc.updated_at) || new Date().toISOString(),
    }, requestId);
  } catch (error) {
    console.error('[checkin] stats failed', error.message);
    return errorResponse(res, 503, 'WRITE_FAILED', '统计服务暂时不可用', requestId);
  }
});

// GET /me — 当前用户打卡摘要
router.get('/me', async (req, res) => {
  const requestId = getRequestId(req);
  const identity = await resolveIdentity(req);
  if (!identity.ok) return errorResponse(res, 401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId);
  if (identity.kind !== 'session' && !identity.subjectId.startsWith('legacy:')) {
    return errorResponse(res, 401, 'SESSION_REQUIRED', '打卡需要有效会话', requestId);
  }

  try {
    return successResponse(res, await getMine(identity.subjectId), requestId);
  } catch (error) {
    console.error('[checkin] /me failed', { requestId, message: error.message });
    return errorResponse(res, 503, 'WRITE_FAILED', '打卡查询失败，请稍后重试', requestId);
  }
});

// GET /me/report — 今日加油卡 AI 报告
router.get('/me/report', async (req, res) => {
  const requestId = getRequestId(req);
  const identity = await resolveIdentity(req);
  if (!identity.ok) return errorResponse(res, 401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId);

  try {
    const report = await getMyReport(identity.subjectId);
    if (!report) return errorResponse(res, 404, 'NOT_FOUND', '今日还没有生成加油卡', requestId);
    return successResponse(res, report, requestId);
  } catch (error) {
    console.error('[checkin] /me/report failed', { requestId, message: error.message });
    return errorResponse(res, 503, 'WRITE_FAILED', '加油卡查询失败', requestId);
  }
});

// POST / — 创建打卡记录
router.post('/', async (req, res) => {
  const requestId = getRequestId(req);
  const identity = await resolveIdentity(req);
  if (!identity.ok) return errorResponse(res, 401, 'SESSION_REQUIRED', '匿名会话无效或已过期', requestId);
  if (identity.kind !== 'session' && !identity.subjectId.startsWith('legacy:')) {
    return errorResponse(res, 401, 'SESSION_REQUIRED', '打卡需要有效会话', requestId);
  }

  const body = req.body || {};
  const clientId = normalizeClientId(body.client_id || body._cid || '');
  if (!isValidClientId(clientId)) return errorResponse(res, 400, 'INVALID_ARGUMENT', 'client_id 不合法', requestId);
  if ('subject_id' in body || 'date' in body) {
    console.warn('[checkin] ignored client-owned fields', { requestId });
  }

  const rateAllowed = await consumeRequestQuota(identity.subjectId, getClientIp(req));
  if (!rateAllowed) return errorResponse(res, 429, 'RATE_LIMITED', '打卡操作过于频繁', requestId, 60);

  try {
    return successResponse(res, await createCheckin(identity.subjectId, body), requestId);
  } catch (error) {
    console.error('[checkin] request failed', { requestId, message: error.message });
    return errorResponse(res, 503, 'WRITE_FAILED', '打卡写入失败，请稍后重试', requestId);
  }
});

// ── 内部函数 ──

async function getMine(subjectId) {
  const clock = shanghaiDate();
  const checkinId = makeCheckinId(subjectId, clock.date);
  const checkinsCol = await collection('checkins');
  const usersCol = await collection('checkin_users');
  const [userResult, todayResult] = await Promise.all([
    usersCol.doc(subjectId).get(),
    checkinsCol.doc(checkinId).get(),
  ]);
  const user = userResult.data && userResult.data[0];
  const today = todayResult.data && todayResult.data[0];
  const summary = user
    ? { streak: Number(user.streak || 0), total_days: Number(user.total_days || 0) }
    : computeCheckinSummary(await getHistory(subjectId));
  return {
    checked_in_today: Boolean(today),
    streak: summary.streak,
    total_days: summary.total_days,
    ...(today ? { today } : {}),
  };
}

async function createCheckin(subjectId, body) {
  const clock = shanghaiDate();
  const checkinId = makeCheckinId(subjectId, clock.date);

  const usersCol = await collection('checkin_users');
  const initialUserResult = await usersCol.doc(subjectId).get();
  const initialUser = initialUserResult.data && initialUserResult.data[0];
  const historySummary = initialUser ? null : computeCheckinSummary(await getHistory(subjectId));

  return withTransactionRetry(async (tc) => {
    const checkins = tc('checkins');
    const users = tc('checkin_users');
    const stats = tc('checkin_daily_stats');

    const existingResult = await checkins.doc(checkinId).get();
    const existing = existingResult.data?.[0];
    if (existing) {
      const statResult = await stats.doc(clock.date).get();
      const stat = statResult.data?.[0];
      return { checkin: existing, already_checked_in: true, today_count: Number((stat && stat.count) || 0) };
    }

    const userResult = await users.doc(subjectId).get();
    const user = userResult.data?.[0];
    const previousLastDate = user ? user.last_date : historySummary.last_date;
    const previousStreak = user ? Number(user.streak || 0) : historySummary.streak;
    const previousTotalDays = user ? Number(user.total_days || 0) : historySummary.total_days;
    const streak = previousLastDate === clock.yesterday ? previousStreak + 1 : 1;
    const totalDays = previousTotalDays + 1;
    const now = new Date().toISOString();

    const checkin = {
      subject_id: subjectId, date: clock.date, tz: 'Asia/Shanghai',
      streak, total_days: totalDays,
      report_id: typeof body.report_id === 'string' ? body.report_id.slice(0, 80) : '',
      created_at: now, updated_at: now,
    };

    await checkins.doc(checkinId).set(checkin);
    await users.doc(subjectId).set({
      last_date: clock.date, streak, total_days: totalDays,
      created_at: (user && user.created_at) || now, updated_at: now,
    });

    const statResult = await stats.doc(clock.date).get();
    const stat = statResult.data?.[0];
    const todayCount = Number((stat && stat.count) || 0) + 1;
    await stats.doc(clock.date).set({ date: clock.date, count: todayCount, updated_at: now });

    return { checkin, already_checked_in: false, today_count: todayCount };
  });
}

async function getHistory(subjectId) {
  const records = [];
  const pageSize = 100;
  const col = await collection('checkins');
  for (let offset = 0; ; offset += pageSize) {
    const result = await col.where({ subject_id: subjectId }).get();
    // MongoDB find 不支持 skip/limit 链式，需简化
    // 实际上这里应该使用 MongoDB skip/limit
    const page = result.data.slice(offset, offset + pageSize);
    records.push(...page);
    if (page.length < pageSize) return records;
  }
}

async function consumeRequestQuota(subjectId, ip) {
  const minute = new Date().toISOString().slice(0, 16);
  const limits = [
    { id: `checkin_user_${hashValue(subjectId)}_${minute}`, limit: 10, dimension: 'user' },
    { id: `checkin_ip_${hashValue(ip, config.ipHashSalt)}_${minute}`, limit: 60, dimension: 'ip' },
  ];
  return runTransaction(async (tc) => {
    const col = tc('usage_limits');
    const current = [];
    for (const item of limits) {
      const result = await col.doc(item.id).get();
      const doc = result.data?.[0];
      const count = Number((doc && doc.count) || 0);
      if (count >= item.limit) return false;
      current.push({ ...item, count });
    }
    const now = new Date().toISOString();
    for (const item of current) {
      await col.doc(item.id).set({
        module: 'checkin', dimension: item.dimension, minute,
        count: item.count + 1, limit: item.limit, updated_at: now,
      });
    }
    return true;
  });
}

async function withTransactionRetry(work) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await runTransaction(work);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getMyReport(subjectId) {
  const clock = shanghaiDate();
  const checkinId = makeCheckinId(subjectId, clock.date);
  const checkinsCol = await collection('checkins');
  const todayResult = await checkinsCol.doc(checkinId).get();
  const today = todayResult.data?.[0];
  const reportId = today && typeof today.report_id === 'string' ? today.report_id : '';
  if (!reportId) return null;

  const aiReportsCol = await collection('ai_reports');
  const reportResult = await aiReportsCol.doc(reportId).get();
  const doc = reportResult.data?.[0];
  if (!doc) return null;
  if (doc.subject_id !== subjectId) return null;

  const output = doc.ai_output || {};
  return {
    lines: Array.isArray(output.lines) ? output.lines : [],
    emoji_caption: typeof output.emoji_caption === 'string' ? output.emoji_caption : '',
    report_id: doc.report_id,
    refs: Array.isArray(output.refs) ? output.refs : [],
    source_snapshot_at: typeof doc.source_snapshot_at === 'string' ? doc.source_snapshot_at : '',
  };
}

module.exports = router;
