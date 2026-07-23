'use strict';

/**
 * story 路由 — ← get-story
 * 查询故事卡数据
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
    const col = await collection('weekly_story');
    let resData;
    if (query.week) {
      resData = await col.where({ week: query.week }).get();
    } else {
      resData = await col.orderBy('created_at', 'desc').limit(1).get();
    }

    if (!resData || !resData.data || resData.data.length === 0) {
      return errorResponse(res, 404, 'NOT_FOUND', '暂无故事卡数据', requestId);
    }

    const doc = resData.data[0];

    // 补充前端期望的字段
    let seasonName = 'KPL2026夏季赛';
    let heroName = '';
    let heroWinRate = 0;
    let liveHours = 0;

    try {
      const ovCol = await collection('season_summaries');
      const ovRes = await ovCol.orderBy('updated_at', 'desc').limit(1).get();
      if (ovRes && ovRes.data && ovRes.data.length > 0) {
        const o = ovRes.data[0];
        seasonName = o.season_name || seasonName;
        const rawData = o.data || {};
        const innerData = rawData.data || rawData;
        const heroStats = innerData.hero_stats || [];
        const heroTop = heroStats.sort((a, b) => (b.battles || 0) - (a.battles || 0)).slice(0, 5);
        if (heroTop.length > 0) {
          heroName = heroTop[0].hero_name || '';
          heroWinRate = parseFloat(heroTop[0].win_rate || '0');
        }
      }
    } catch (_) {}

    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const liveCol = await collection('live_streams');
      const liveRes = await liveCol.where({ year, month }).get();
      const streams = (liveRes.data || []).filter((s) => s.type !== 'monthly_summary');
      const totalSeconds = streams.reduce((sum, s) => sum + (s.duration || 0), 0);
      liveHours = Math.round(totalSeconds / 360) / 10;
    } catch (_) {}

    const statsPayload = normalizeStats(doc.stats || {});

    const payload = {
      week: doc.week,
      season_name: seasonName,
      text: doc.text,
      stats: statsPayload,
      cover_color: doc.cover_color,
      created_at: doc.created_at,
      hero: { name: heroName, win_rate: heroWinRate },
      live_hours: liveHours,
    };

    return successResponse(res, payload, requestId);
  } catch (err) {
    return errorResponse(res, 500, 'INTERNAL_ERROR', err.message, requestId);
  }
});

function normalizeStats(stats) {
  let winRateDiff = stats.win_rate_diff != null ? stats.win_rate_diff
    : stats.winRateDiff != null ? stats.winRateDiff
    : stats.win_rate && stats.win_rate.diff != null ? Math.round(stats.win_rate.diff * 1000) / 10 : 0;
  if (winRateDiff > -1 && winRateDiff < 1) winRateDiff = Math.round(winRateDiff * 1000) / 10;

  const kdaDiff = stats.kda_diff != null ? stats.kda_diff
    : stats.kdaDiff != null ? stats.kdaDiff
    : stats.kda_ratio && stats.kda_ratio.diff != null ? stats.kda_ratio.diff : 0;

  const battlesDiff = stats.battles_diff != null ? stats.battles_diff
    : stats.battlesDiff != null ? stats.battlesDiff
    : stats.battles && stats.battles.diff != null ? stats.battles.diff : 0;

  return Object.assign({}, stats, {
    win_rate_diff: winRateDiff,
    kda_diff: kdaDiff,
    battles_diff: battlesDiff,
  });
}

module.exports = router;
