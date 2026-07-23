'use strict';

/**
 * schedule 路由 — ← get-schedule
 * 查询赛程数据，含实时窗口状态计算
 */

const express = require('express');
const { collection } = require('../db/mongo');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId } = require('../utils/helpers');
const { computeWindowStatus } = require('../lib/schedule-merge');

const router = express.Router();

router.get('/', async (req, res) => {
  const requestId = getRequestId(req);
  const query = req.query || {};

  try {
    const col = await collection('match_schedules');
    let resData;
    if (query.seasonid) {
      resData = await col.where({ season_id: query.seasonid }).get();
    } else {
      resData = await col.orderBy('updated_at', 'desc').limit(1).get();
    }

    if (resData.data.length === 0) {
      return errorResponse(res, 503, 'NO_DATA', '赛程暂不可用', requestId);
    }

    const doc = resData.data[0];
    const matches = doc.matches || [];
    const windowStatus = computeWindowStatus(matches);

    const payload = {
      season_name: doc.season_name,
      matches,
      updated_at: doc.updated_at,
      last_live_synced_at: doc.last_live_synced_at || null,
      sync_mode: windowStatus.window_active ? 'live' : 'daily',
      window_active: windowStatus.window_active,
    };

    return successResponse(res, payload, requestId);
  } catch (err) {
    return errorResponse(res, 500, 'INTERNAL_ERROR', err.message, requestId);
  }
});

module.exports = router;
