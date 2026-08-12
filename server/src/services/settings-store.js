'use strict';

/**
 * 运行时配置存储 — app_config 集合
 *
 * 统一封装两类线上可改配置，供「文案生成」与「调度器」共享读取：
 *   - app_config/cheer_settings   { data_mode }
 *   - app_config/scheduler_settings { weekly_story_enabled, kpl_crawl_cron }
 *
 * 优先级：MongoDB（管理页面修改） > env / schedules.js 默认值。
 * 修改无需重启容器，立即生效。
 */

const { collection } = require('../db/mongo');
const config = require('../config/env');
const { CRON } = require('../jobs/schedules');

const CHEER_DOC = 'cheer_settings';
const SCHEDULER_DOC = 'scheduler_settings';

const CHEER_DATA_MODES = ['season', 'career', 'emotion'];

function isValidCheerDataMode(mode) {
  return CHEER_DATA_MODES.includes(mode);
}

// ── 进程内 TTL 缓存 ──
// /api/cheer 是热路径，配置又极少变化，避免每次请求都打一次 MongoDB
const CACHE_TTL_MS = 30 * 1000; // 30s
const cache = new Map();

function readCache(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.value;
  return null;
}

function writeCache(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

function invalidateCache(key) {
  cache.delete(key);
}

// ── cheer 数据模式 ──

async function getCheerDataMode() {
  const cached = readCache(CHEER_DOC);
  if (cached) return cached;

  let value = { mode: config.cheerDataMode, source: 'env' };
  try {
    const col = await collection('app_config');
    const result = await col.doc(CHEER_DOC).get();
    const doc = result.data && result.data[0];
    if (doc && isValidCheerDataMode(doc.data_mode)) {
      value = { mode: doc.data_mode, source: 'db' };
    } else if (doc && doc.data_mode) {
      console.warn('[settings-store] invalid data_mode in DB:', doc.data_mode, '— falling back to env');
    }
    writeCache(CHEER_DOC, value);
  } catch (error) {
    // DB 不可用时降级到 env，但不写缓存，下次请求继续尝试
    console.warn('[settings-store] getCheerDataMode fallback to env:', error.message);
  }
  return value;
}

async function setCheerDataMode(mode) {
  if (!isValidCheerDataMode(mode)) {
    throw new Error(`invalid data_mode: ${mode}`);
  }
  const col = await collection('app_config');
  await col.doc(CHEER_DOC).set({ data_mode: mode, updated_at: new Date().toISOString() });
  invalidateCache(CHEER_DOC);
  return { mode, source: 'db' };
}

// ── 调度配置 ──

async function getSchedulerSettings() {
  const cached = readCache(SCHEDULER_DOC);
  if (cached) return cached;

  const defaults = {
    weekly_story_enabled: config.weeklyStoryEnabled,
    kpl_crawl_cron: CRON.kpl_crawl,
    source: 'env',
  };
  try {
    const col = await collection('app_config');
    const result = await col.doc(SCHEDULER_DOC).get();
    const doc = result.data && result.data[0];
    const value = doc
      ? {
        weekly_story_enabled:
            typeof doc.weekly_story_enabled === 'boolean' ? doc.weekly_story_enabled : defaults.weekly_story_enabled,
        kpl_crawl_cron:
            typeof doc.kpl_crawl_cron === 'string' && doc.kpl_crawl_cron ? doc.kpl_crawl_cron : defaults.kpl_crawl_cron,
        source: 'db',
      }
      : defaults;
    writeCache(SCHEDULER_DOC, value);
    return value;
  } catch (error) {
    // DB 不可用时降级到默认值，但不写缓存
    console.warn('[settings-store] getSchedulerSettings fallback to defaults:', error.message);
    return defaults;
  }
}

async function setSchedulerSettings(patch) {
  const col = await collection('app_config');
  // 先读原文档做合并，避免 set() 整文档替换抹掉未知字段
  const existingResult = await col.doc(SCHEDULER_DOC).get();
  const existing = (existingResult.data && existingResult.data[0]) || {};
  const current = await getSchedulerSettings();
  const next = Object.assign({}, existing, {
    weekly_story_enabled:
      typeof patch.weekly_story_enabled === 'boolean' ? patch.weekly_story_enabled : current.weekly_story_enabled,
    kpl_crawl_cron:
      typeof patch.kpl_crawl_cron === 'string' && patch.kpl_crawl_cron ? patch.kpl_crawl_cron : current.kpl_crawl_cron,
    updated_at: new Date().toISOString(),
  });
  delete next._id; // _id 由 doc().set() 自行写入，避免重复
  await col.doc(SCHEDULER_DOC).set(next);
  invalidateCache(SCHEDULER_DOC);
  return Object.assign({}, next, { source: 'db' });
}

module.exports = {
  CHEER_DATA_MODES,
  isValidCheerDataMode,
  getCheerDataMode,
  setCheerDataMode,
  getSchedulerSettings,
  setSchedulerSettings,
};
