'use strict';

/**
 * /api/materials — 公开素材查询（只读）
 *
 * GET /api/materials?category=&album= — 返回已启用素材（渲染所需字段）
 */

const express = require('express');
const router = express.Router();
const { listPublicMaterials } = require('../services/materials');

router.get('/', async (req, res) => {
  try {
    const materials = await listPublicMaterials({
      category: typeof req.query.category === 'string' ? req.query.category : '',
      album: typeof req.query.album === 'string' ? req.query.album : '',
    });
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ ok: true, data: materials });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
