'use strict';

/**
 * 定时任务调度器 — node-cron 替代 TCB 定时触发器
 */

const cron = require('node-cron');
const { syncScheduleLive } = require('./syncScheduleLive');
const { weeklyStory } = require('./weeklyStory');
const { cleanupAiReports } = require('./cleanupAiReports');


function startScheduler() {

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
