'use strict';

/**
 * overview 路由 — ← get-overview
 * 查询最新赛季概览数据
 */

const express = require('express');
const { collection } = require('../db/mongo');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId, isObject } = require('../utils/helpers');

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
    const seasonId = doc.season || '';

    const seasonStats = (innerData.season_stats || []).find((s) => s.season_id === seasonId) || {};
    const heroStats = innerData.hero_stats || [];
    const heroTop = heroStats.sort((a, b) => (b.battles || 0) - (a.battles || 0)).slice(0, 10);

    const overview = {
      player_info: innerData.player_info || {},
      career_summary: innerData.career_summary || {},
      current_season: seasonStats,
      hero_top: heroTop,
      team_stats: innerData.team_stats || [],
      recent_matches: innerData.recent_matches || [],
    };

    const payload = {
      season: doc.season,
      season_name: doc.season_name,
      player_name: doc.player_name,
      team_name: doc.team_name,
      updated_at: doc.updated_at,
      overview,
    };

    return successResponse(res, payload, requestId);
  } catch (err) {
    return errorResponse(res, 500, 'INTERNAL_ERROR', err.message, requestId);
  }
});

module.exports = router;
