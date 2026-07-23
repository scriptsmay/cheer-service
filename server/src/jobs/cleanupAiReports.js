'use strict';

/**
 * cleanupAiReports job — ← cleanup-ai-reports
 * 每日 03:20，清理过期 AI 报告
 */

const { collection, command } = require('../db/mongo');

async function cleanupAiReports() {
  const now = new Date().toISOString();
  let deleted = 0;

  const col = await collection('ai_reports');

  for (let page = 0; page < 20; page += 1) {
    const result = await col.where({
      expires_at: command.lte(now),
      status: command.neq('under_review'),
    }).get();

    const documents = Array.isArray(result.data) ? result.data : [];
    if (documents.length === 0) break;

    for (const document of documents) {
      if (!document || typeof document._id !== 'string') continue;
      await col.doc(document._id).remove();
      deleted += 1;
    }

    if (documents.length < 100) break;
  }

  console.log('[cleanup-ai-reports] completed', { deleted, now });
  return { ok: true, deleted, now };
}

module.exports = { cleanupAiReports };
