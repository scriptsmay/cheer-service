'use strict';

/**
 * 定时任务调度器 — node-cron 替代 TCB 定时触发器
 *
 * 任务句柄保存在 Map 中。cron 表达式统一取自 schedules.js 的固定默认值：
 * KPL 数据采集已在宿主机 systemd timer 执行（业务分离），容器内任务只负责
 * 读取挂载数据同步 MongoDB 与周报/清理，不再提供后台改频道的入口。
 */

const cron = require('node-cron');
const config = require('../config/env');
const { syncKplCrawl } = require('./syncKplCrawl');
const { syncScheduleLive } = require('./syncScheduleLive');
const { weeklyStory } = require('./weeklyStory');
const { cleanupAiReports } = require('./cleanupAiReports');
const { CRON } = require('./schedules');
const { getSchedulerSettings } = require('../services/settings-store');

// 注：jobs/syncLive.js 未在此导入、也不注册进调度器——它依赖部署中未提供的
// DATA_BASE_URL（见 server/src/config/env.js），迁移前即被禁用。详见该文件头部说明
// 与 docs/kpl-crawl-migration.md 的勘误段。

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
      console.log('[scheduler] kpl_crawl skipped (CRAWL_ENABLED=false)');
      return;
    }
    console.log('[scheduler] Running kpl_crawl (file → MongoDB sync) at', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
    try {
      const results = await syncKplCrawl();
      console.log('[scheduler] kpl_crawl result:', JSON.stringify(results));
    } catch (e) {
      console.error('[scheduler] kpl_crawl error:', e.message);
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

async function startScheduler() {
  register('kpl_crawl', CRON.kpl_crawl);
  register('kpl_live', CRON.kpl_live);
  register('weekly_story', CRON.weekly_story);
  register('cleanup_ai', CRON.cleanup_ai);

  console.log('[scheduler] All cron jobs registered');
}

module.exports = { startScheduler };
