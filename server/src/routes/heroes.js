'use strict';

/**
 * heroes 路由 — ← get-heroes
 * 查询英雄数据
 */

const express = require('express');
const { collection } = require('../db/mongo');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId } = require('../utils/helpers');

const router = express.Router();

router.get('/', async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const col = await collection('season_summaries');
    const result = await col.orderBy('updated_at', 'desc').limit(1).get();

    if (result.data.length === 0) {
      return errorResponse(res, 404, 'NOT_FOUND', '暂无数据', requestId);
    }

    const doc = result.data[0];
    const rawData = doc.data || {};
    const innerData = rawData.data || rawData;
    const heroStats = innerData.hero_stats || [];

    const payload = {
      season: doc.season,
      season_name: doc.season_name,
      player_name: doc.player_name,
      team_name: doc.team_name,
      updated_at: doc.updated_at,
      hero_stats: heroStats,
    };

    return successResponse(res, payload, requestId);
  } catch (err) {
    console.error('[get-heroes] Error:', err.message);
    return errorResponse(res, 500, 'INTERNAL_ERROR', err.message, requestId);
  }
});

module.exports = router;
