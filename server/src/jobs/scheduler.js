'use strict';

/**
 * 定时任务调度器 — node-cron 替代 TCB 定时触发器
 *
 * 任务句柄保存在 Map 中，支持运行时热重载（rescheduleTask）。
 * 启动时优先读取 app_config.scheduler_settings，DB 有值优先于 schedules.js 默认，
 * 避免容器重启后覆盖线上通过管理页面所做的配置。
 */

const cron = require('node-cron');
const config = require('../config/env');
const { syncKplCrawl } = require('./syncKplCrawl');
const { syncData } = require('./syncData');
const { syncSchedule } = require('./syncSchedule');
const { syncScheduleLive } = require('./syncScheduleLive');
const { weeklyStory } = require('./weeklyStory');
const { cleanupAiReports } = require('./cleanupAiReports');
const { CRON, assertValidCron } = require('./schedules');
const { getSchedulerSettings } = require('../services/settings-store');

// key → cron.ScheduledTask
const tasks = new Map();
// 已在执行的任务名集合，用于防止长任务重叠触发
const running = new Set();

function withOverlapGuard(key, fn) {
  return async () => {
    if (running.has(key)) {
      console.log(`[scheduler] ${key} skipped (previous invocation still running)`);
      return;
    }
    running.add(key);
    try {
      await fn();
    } finally {
      running.delete(key);
    }
  };
}

// ── 任务处理器（模块级映射，便于重建）──
const handlers = {
  kpl_crawl: withOverlapGuard('kpl_crawl', async () => {
    if (!config.crawlEnabled) {
      console.log('[scheduler] syncKplCrawl skipped (CRAWL_ENABLED=false)');
      return;
    }
    console.log('[scheduler] Running syncKplCrawl at', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
    try {
      const results = await syncKplCrawl();
      if (results.hasChanges) {
        console.log('[scheduler] Data changed, running syncData + syncSchedule');
        try {
          await syncData();
        } catch (e) {
          console.error('[scheduler] syncData error:', e.message);
        }
        try {
          await syncSchedule();
        } catch (e) {
          console.error('[scheduler] syncSchedule error:', e.message);
        }
      } else {
        console.log('[scheduler] No data changes, skipping syncData + syncSchedule');
      }
    } catch (e) {
      console.error('[scheduler] syncKplCrawl error:', e.message);
    }
  }),

  kpl_live: async () => {
    if (!config.crawlEnabled) {
      return; // 静默跳过，避免每 10 分钟刷日志
    }
    console.log('[scheduler] Running syncScheduleLive every 10 min');
    try {
      await syncScheduleLive();
    } catch (e) {
      console.error('[scheduler] syncScheduleLive error:', e.message);
    }
  },

  weekly_story: async () => {
    // 运行时读 app_config，管理页面改完立即生效（不依赖 env / 重启）
    let enabled = config.weeklyStoryEnabled;
    try {
      const settings = await getSchedulerSettings();
      enabled = settings.weekly_story_enabled;
    } catch (e) {
      console.warn('[scheduler] weeklyStory settings read failed, using default:', e.message);
    }
    if (!enabled) {
      console.log('[scheduler] weeklyStory skipped (disabled in app_config)');
      return;
    }
    console.log('[scheduler] Running weeklyStory at Monday 05:00');
    try {
      await weeklyStory();
    } catch (e) {
      console.error('[scheduler] weeklyStory error:', e.message);
    }
  },

  cleanup_ai: async () => {
    console.log('[scheduler] Running cleanupAiReports at 03:20');
    try {
      await cleanupAiReports();
    } catch (e) {
      console.error('[scheduler] cleanupAiReports error:', e.message);
    }
  },
};

// ── 注册 / 重建单个任务 ──
function register(key, cronExpr) {
  const handler = handlers[key];
  if (!handler) {
    throw new Error(`unknown task: ${key}`);
  }
  const existing = tasks.get(key);
  if (existing) {
    existing.stop();
    // node-cron v3 ScheduledTask.destroy() 从内部注册表移除引用，避免反复
    // reschedule 时孤儿任务累积占内存；老版本无该方法时静默跳过
    if (typeof existing.destroy === 'function') {
      existing.destroy();
    }
  }
  tasks.set(key, cron.schedule(cronExpr, handler));
}

/**
 * 运行时重建任务（供 admin 接口调用）。
 * 校验 cron 合法性后销毁旧任务、按新表达式重建。
 * @returns {string} 新表达式（合法时）
 */
function rescheduleTask(key, cronExpr) {
  if (!handlers[key]) {
    throw new Error(`unknown task: ${key}`);
  }
  assertValidCron(cronExpr); // 非法则抛错，调用方转 400
  register(key, cronExpr);
  console.log(`[scheduler] rescheduled ${key} → ${cronExpr}`);
  return cronExpr;
}

async function startScheduler() {
  // DB 配置优先，读取失败降级到默认值（不阻塞启动）
  let kplCrawlCron = CRON.kpl_crawl;
  try {
    const settings = await getSchedulerSettings();
    if (settings.kpl_crawl_cron) {
      kplCrawlCron = settings.kpl_crawl_cron;
    }
    console.log(`[scheduler] loaded settings (source=${settings.source}), kpl_crawl cron=${kplCrawlCron}`);
  } catch (e) {
    console.warn('[scheduler] settings read failed, using defaults:', e.message);
  }

  // 若 DB 中的 cron 曾在旧宽松校验下写入了 node-cron 不支持的表达式，
  // 启动时会抛错导致 process.exit(1)。这里做一次防御性校验，非法就回退默认。
  try {
    assertValidCron(kplCrawlCron);
  } catch (e) {
    console.error(`[scheduler] invalid stored kpl_crawl_cron "${kplCrawlCron}": ${e.message} — using default`);
    kplCrawlCron = CRON.kpl_crawl;
  }

  register('kpl_crawl', kplCrawlCron);
  register('kpl_live', CRON.kpl_live);
  register('weekly_story', CRON.weekly_story);
  register('cleanup_ai', CRON.cleanup_ai);

  console.log('[scheduler] All cron jobs registered');
}

module.exports = { startScheduler, rescheduleTask };
