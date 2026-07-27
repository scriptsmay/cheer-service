'use strict';

/**
 * 定时任务调度器 — node-cron 替代 TCB 定时触发器
 */

const cron = require('node-cron');
const config = require('../config/env');
const { syncKplCrawl } = require('./syncKplCrawl');
const { syncData } = require('./syncData');
const { syncSchedule } = require('./syncSchedule');
const { syncScheduleLive } = require('./syncScheduleLive');
const { weeklyStory } = require('./weeklyStory');
const { cleanupAiReports } = require('./cleanupAiReports');
const { CRON } = require('./schedules');


function startScheduler() {
  // 03:00, 09:00, 15:00, 21:00 Python 采集 (main.py + fetch-schedule.py)
  // 第三方 API 通常在比赛后 18-22h 更新选手数据，6 小时一次能在更新后及时拉取
  // 采集后有数据变更才自动触发 syncData + syncSchedule 入库
  cron.schedule(CRON.kpl_crawl, async () => {
    if (!config.crawlEnabled) {
      console.log('[scheduler] syncKplCrawl skipped (CRAWL_ENABLED=false)');
      return;
    }
    console.log('[scheduler] Running syncKplCrawl at', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
    try {
      const results = await syncKplCrawl();
      if (results.hasChanges) {
        console.log('[scheduler] Data changed, running syncData + syncSchedule');
        try { await syncData(); } catch (e) { console.error('[scheduler] syncData error:', e.message); }
        try { await syncSchedule(); } catch (e) { console.error('[scheduler] syncSchedule error:', e.message); }
      } else {
        console.log('[scheduler] No data changes, skipping syncData + syncSchedule');
      }
    } catch (e) { console.error('[scheduler] syncKplCrawl error:', e.message); }
  });

  cron.schedule(CRON.kpl_live, async () => {
    if (!config.crawlEnabled) {
      return; // 静默跳过，避免每 10 分钟刷日志
    }
    console.log('[scheduler] Running syncScheduleLive every 10 min');
    try { await syncScheduleLive(); } catch (e) { console.error('[scheduler] syncScheduleLive error:', e.message); }
  });

  cron.schedule(CRON.weekly_story, async () => {
    console.log('[scheduler] Running weeklyStory at Monday 05:00');
    try { await weeklyStory(); } catch (e) { console.error('[scheduler] weeklyStory error:', e.message); }
  });

  cron.schedule(CRON.cleanup_ai, async () => {
    console.log('[scheduler] Running cleanupAiReports at 03:20');
    try { await cleanupAiReports(); } catch (e) { console.error('[scheduler] cleanupAiReports error:', e.message); }
  });

  console.log('[scheduler] All cron jobs registered');
}

module.exports = { startScheduler };
