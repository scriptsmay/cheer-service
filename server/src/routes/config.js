'use strict';

/**
 * config 路由 — ← get-config
 * 获取前端配置（公开接口，无需鉴权）
 */

const express = require('express');
const { collection } = require('../db/mongo');
const { successResponse, errorResponse } = require('../services/response');
const { getRequestId, positiveInt } = require('../utils/helpers');

const DEFAULT_CONFIG = { ask_daily_limit: 10, cheer_daily_limit: 10 };

const router = express.Router();

router.get('/', async (req, res) => {
  const requestId = getRequestId(req);

  const config = { ...DEFAULT_CONFIG };
  try {
    const col = await collection('app_config');
    const result = await col.doc('ai_limits').get();
    const document = result.data && result.data[0];
    if (document) {
      config.ask_daily_limit = positiveInt(document.ask_daily_limit, DEFAULT_CONFIG.ask_daily_limit);
      config.cheer_daily_limit = positiveInt(document.cheer_daily_limit, DEFAULT_CONFIG.cheer_daily_limit);
    }
  } catch (error) {
    console.warn('[get-config] using defaults', error.message);
  }

  return successResponse(res, config, requestId);
});

module.exports = router;
