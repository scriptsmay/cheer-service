'use strict';

/**
 * syncLive job — ← sync-live
 * 每日 05:00，拉取直播记录写入 MongoDB
 *
 * ⚠️ 本 job 当前**未注册进调度器**（server/src/jobs/scheduler.js 只注册
 * kpl_crawl / kpl_live / weekly_story / cleanup_ai），因此不会被执行；
 * GET /api/live 返回的是 live_streams 中的历史数据，不再更新。
 *
 * 未注册的原因：本 job 依赖 `config.dataBaseUrl`（`DATA_BASE_URL` 环境变量），
 * 而该变量在 .env.example / .env.deploy.example / docker-compose.yml 中均未提供，
 * env.js 的默认值为空字符串，会使 API_BASE 退化为非法相对路径、请求必然失败。
 *
 * 如需恢复：① 在部署环境配置 `DATA_BASE_URL`（指向提供 GET /api/streams 的服务）；
 * ② 在 scheduler.js 中重新注册本 job。
 */

const { collection } = require('../db');
const config = require('../config/env');

const API_BASE = `${config.dataBaseUrl}/api/streams`;

async function syncLive(event = {}) {
  const now = new Date();
  const currentYear = event.year || now.getFullYear();
  const currentMonth = event.month || now.getMonth() + 1;

  const months = [
    { year: currentYear, month: currentMonth },
    { year: currentMonth === 1 ? currentYear - 1 : currentYear, month: currentMonth === 1 ? 12 : currentMonth - 1 },
  ];

  const results = [];

  for (const { year, month } of months) {
    console.log(`Fetching streams for ${year}-${month}`);
    const data = await fetchStreams(year, month);

    if (!data || !data.streams) {
      results.push({ month: `${year}-${month}`, status: 'api_error' });
      continue;
    }
    if (data.streams.length === 0) {
      results.push({ month: `${year}-${month}`, status: 'empty', sessions: 0 });
      continue;
    }

    const count = await upsertStreams(data.streams, year, month);
    await upsertSummary(year, month, data.summary);
    results.push({ month: `${year}-${month}`, status: 'ok', sessions: count, summary: data.summary });
  }

  const col = await collection('sync_snapshots');
  await col.add({ type: 'live_streams', status: 'success', results, created_at: new Date().toISOString() });
  return { success: true, results };
}

async function fetchStreams(year, month) {
  const url = `${API_BASE}?year=${year}&month=${month}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.error(`API ${url} returned ${res.status}`); return null; }
    return await res.json();
  } catch (err) { console.error(`Failed to fetch ${url}:`, err.message); return null; }
}

async function upsertStreams(streams, year, month) {
  let count = 0;
  const col = await collection('live_streams');
  for (const s of streams) {
    const doc = {
      stream_date: s.date, year, month, start_time: s.startTime,
      duration: s.duration, title: s.title, external_id: s.id,
      updated_at: new Date().toISOString(),
    };
    const existing = await col.where({ stream_date: s.date, external_id: s.id }).get();
    if (existing.data?.length > 0) {
      await col.doc(existing.data[0]._id).update(doc);
    } else {
      await col.add(doc);
    }
    count++;
  }
  return count;
}

async function upsertSummary(year, month, summary) {
  const col = await collection('live_streams');
  const doc = {
    type: 'monthly_summary', year, month,
    month_key: `${year}-${String(month).padStart(2, '0')}`,
    total_days: summary.totalDays, total_sessions: summary.totalSessions,
    total_hours: summary.totalHours, avg_hours_per_session: summary.avgHoursPerSession,
    updated_at: new Date().toISOString(),
  };
  const existing = await col.where({ type: 'monthly_summary', month_key: doc.month_key }).get();
  if (existing.data?.length > 0) {
    await col.doc(existing.data[0]._id).update(doc);
  } else {
    await col.add(doc);
  }
}

module.exports = { syncLive };
