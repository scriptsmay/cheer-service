'use strict';

/**
 * 定时任务调度器 — node-cron 替代 TCB 定时触发器
 */

const cron = require('node-cron');
const { syncData } = require('./syncData');
const { syncLive } = require('./syncLive');
const { syncSchedule } = require('./syncSchedule');
const { syncScheduleLive } = require('./syncScheduleLive');
const { weeklyStory } = require('./weeklyStory');
const { cleanupAiReports } = require('./cleanupAiReports');

function startScheduler() {
  // TCB cron: "0 0 4 * * * *" (秒分时日月周) → node-cron: "0 4 * * *" (分时日月周)
  cron.schedule('0 4 * * *', async () => {
    console.log('[scheduler] Running syncData at 04:00');
    try { await syncData(); } catch (e) { console.error('[scheduler] syncData error:', e.message); }
  });

  cron.schedule('0 5 * * *', async () => {
    console.log('[scheduler] Running syncLive at 05:00');
    try { await syncLive(); } catch (e) { console.error('[scheduler] syncLive error:', e.message); }
  });

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
