'use strict';

/**
 * live 路由 — ← get-live
 * 查询直播数据
 */

const express = require('express');
const { collection } = require('../db/mongo');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId } = require('../utils/helpers');

const router = express.Router();

router.get('/', async (req, res) => {
  const requestId = getRequestId(req);
  const query = req.query || {};

  try {
    const now = new Date();
    const year = parseInt(query.year) || now.getFullYear();
    const month = parseInt(query.month) || now.getMonth() + 1;

    const col = await collection('live_streams');
    const streamsRes = await col.where({ year, month }).get();

    const streams = (streamsRes.data || []).filter((s) => s.type !== 'monthly_summary');

    const totalSessions = streams.length;
    const totalSeconds = streams.reduce((sum, s) => sum + (s.duration || 0), 0);
    const totalHours = Math.round(totalSeconds / 360) / 10;
    const avgHoursPerSession = totalSessions > 0 ? Math.round((totalSeconds / 3600 / totalSessions) * 10) / 10 : 0;

    const summary = totalSessions > 0
      ? {
          total_days: [...new Set(streams.map((s) => s.stream_date || '').filter(Boolean))].length,
          total_sessions: totalSessions,
          total_hours: totalHours,
          avg_hours_per_session: avgHoursPerSession,
          computed: true,
        }
      : null;

    const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;

    const payload = { year, month, is_current: isCurrent, summary, streams };
    return successResponse(res, payload, requestId);
  } catch (err) {
    return errorResponse(res, 500, 'INTERNAL_ERROR', err.message, requestId);
  }
});

module.exports = router;
