'use strict';

/**
 * cron 路由 — Vercel Cron 触发（v1.4.0 Phase 3）
 *
 * GET /api/cron/daily：Vercel Cron 每日一次（20 3 * * *），合并执行
 * cleanup_ai（AI 报告清理）+ kpl_crawl（GitHub raw → 数据库同步），顺带作为
 * Supabase 免费档保活心跳。txyun 过渡期 scheduler 仍跑同两个任务（幂等无害）。
 *
 * 鉴权：配置 CRON_SECRET 后要求 Authorization: Bearer <CRON_SECRET>
 * （Vercel Cron 会自动带上该头）；未配置时仅本地/开发环境放行。
 */

const express = require('express');
const config = require('../config/env');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId, getErrorMessage } = require('../utils/helpers');

let cleanupAiReports;
let syncKplCrawl;
try { cleanupAiReports = require('../jobs/cleanupAiReports').cleanupAiReports; } catch (_) {}
try { syncKplCrawl = require('../jobs/syncKplCrawl').syncKplCrawl; } catch (_) {}

const router = express.Router();

function cronGuard(req, res, next) {
  if (!config.cronSecret) {
    if (config.allowLocalhost || process.env.NODE_ENV !== 'production') return next();
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'CRON_SECRET 未配置，拒绝生产环境触发' });
  }
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${config.cronSecret}`) return next();
  return res.status(401).json({ code: 'UNAUTHORIZED', message: 'cron 鉴权失败' });
}

router.get('/daily', cronGuard, async (req, res) => {
  const requestId = getRequestId(req);
  const results = { cleanup: null, kpl_crawl: null };

  try {
    if (cleanupAiReports) {
      await cleanupAiReports();
      results.cleanup = 'ok';
    } else {
      results.cleanup = 'skipped (job unavailable)';
    }
  } catch (error) {
    console.error('[cron] cleanupAiReports failed:', getErrorMessage(error));
    results.cleanup = `failed: ${getErrorMessage(error)}`;
  }

  try {
    if (syncKplCrawl) {
      const summary = await syncKplCrawl();
      results.kpl_crawl = summary || 'ok';
    } else {
      results.kpl_crawl = 'skipped (job unavailable)';
    }
  } catch (error) {
    console.error('[cron] syncKplCrawl failed:', getErrorMessage(error));
    results.kpl_crawl = `failed: ${getErrorMessage(error)}`;
  }

  const hasFailure = [results.cleanup, results.kpl_crawl].some((r) => typeof r === 'string' && r.startsWith('failed'));
  if (hasFailure) {
    return errorResponse(res, 500, 'CRON_PARTIAL_FAILED', '部分定时任务执行失败', requestId);
  }
  return successResponse(res, results, requestId);
});

module.exports = router;
