'use strict';

/**
 * 定时任务调度器 — node-cron 替代 TCB 定时触发器
 */

const cron = require('node-cron');
const { syncKplCrawl } = require('./syncKplCrawl');
const { syncData } = require('./syncData');
const { syncSchedule } = require('./syncSchedule');
const { syncScheduleLive } = require('./syncScheduleLive');
const { weeklyStory } = require('./weeklyStory');
const { cleanupAiReports } = require('./cleanupAiReports');


function startScheduler() {
  // 03:00 Python 采集 (main.py + fetch-schedule.py)
  cron.schedule('0 3 * * *', async () => {
    console.log('[scheduler] Running syncKplCrawl at 03:00');
    try { await syncKplCrawl(); } catch (e) { console.error('[scheduler] syncKplCrawl error:', e.message); }
  });

  // 04:00 赛季概览入库（本地文件读取）
  cron.schedule('0 4 * * *', async () => {
    console.log('[scheduler] Running syncData at 04:00');
    try { await syncData(); } catch (e) { console.error('[scheduler] syncData error:', e.message); }
  });

  // 06:00 赛程入库（本地文件读取）
  cron.schedule('0 6 * * *', async () => {
    console.log('[scheduler] Running syncSchedule at 06:00');
    try { await syncSchedule(); } catch (e) { console.error('[scheduler] syncSchedule error:', e.message); }
  });

  cron.schedule('*/10 * * * *', async () => {
    console.log('[scheduler] Running syncScheduleLive every 10 min');
    try { await syncScheduleLive(); } catch (e) { console.error('[scheduler] syncScheduleLive error:', e.message); }
  });

  cron.schedule('0 5 * * 1', async () => {
    console.log('[scheduler] Running weeklyStory at Monday 05:00');
    try { await weeklyStory(); } catch (e) { console.error('[scheduler] weeklyStory error:', e.message); }
  });

  cron.schedule('20 3 * * *', async () => {
    console.log('[scheduler] Running cleanupAiReports at 03:20');
    try { await cleanupAiReports(); } catch (e) { console.error('[scheduler] cleanupAiReports error:', e.message); }
  });

  console.log('[scheduler] All cron jobs registered');
}

module.exports = { startScheduler };
