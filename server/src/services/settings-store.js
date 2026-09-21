'use strict';

/**
 * 运行时配置存储 — app_config 集合 + 应援事件表
 *
 * 统一封装两类线上可改配置，供「文案生成」与「调度器」共享读取：
 *   - app_config/cheer_settings    { data_mode, date_context_enabled, humanize_enabled, event_context_enabled }
 *   - app_config/scheduler_settings { weekly_story_enabled }
 *   - cheer_events（集合，每事件一个 doc，_id 为幂等键）
 *
 * 优先级：MongoDB（管理页面修改） > env / schedules.js 默认值。
 * 修改无需重启容器，立即生效。
 */

const { collection } = require('../db');
const config = require('../config/env');
const { resolveEventPhase } = require('../lib/date-context');
const { DEFAULT_PROMPTS, validateTemplate } = require('../lib/prompt-template');

const CHEER_DOC = 'cheer_settings';
const SCHEDULER_DOC = 'scheduler_settings';
const EVENTS_COLLECTION = 'cheer_events';

const CHEER_DATA_MODES = ['season', 'career', 'emotion'];

// 新增开关的默认值（未在 DB 配置时）
const CHEER_SETTING_DEFAULTS = {
  date_context_enabled: true,
  humanize_enabled: true,
  event_context_enabled: true,
};

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

async function readCheerDoc() {
  const col = await collection('app_config');
  const result = await col.doc(CHEER_DOC).get();
  return (result.data && result.data[0]) || null;
}

// ── cheer 设置（数据模式 + 三个功能开关，单一 DB 读取入口）──

async function getCheerSettings() {
  const cached = readCache(CHEER_DOC);
  if (cached) return cached;

  const value = {
    mode: config.cheerDataMode,
    ...CHEER_SETTING_DEFAULTS,
    prompts: { ...DEFAULT_PROMPTS }, // DB 不可用/未配置时回代码默认（version 0）
    source: 'env',
  };
  try {
    const doc = await readCheerDoc();
    if (doc) {
      value.mode = isValidCheerDataMode(doc.data_mode) ? doc.data_mode : value.mode;
      value.date_context_enabled = typeof doc.date_context_enabled === 'boolean'
        ? doc.date_context_enabled : CHEER_SETTING_DEFAULTS.date_context_enabled;
      value.humanize_enabled = typeof doc.humanize_enabled === 'boolean'
        ? doc.humanize_enabled : CHEER_SETTING_DEFAULTS.humanize_enabled;
      value.event_context_enabled = typeof doc.event_context_enabled === 'boolean'
        ? doc.event_context_enabled : CHEER_SETTING_DEFAULTS.event_context_enabled;
      // 提示词配置（v1.1.0）：子文档逐字段合并代码默认，随同一份 30s TTL 缓存生效
      value.prompts = mergePromptConfig(doc.prompts);
      value.source = 'db';
    }
    writeCache(CHEER_DOC, value);
  } catch (error) {
    // DB 不可用时降级到默认值，但不写缓存，下次请求继续尝试
    console.warn('[settings-store] getCheerSettings fallback to defaults:', error.message);
  }
  return value;
}

async function getCheerDataMode() {
  const settings = await getCheerSettings();
  return { mode: settings.mode, source: settings.source };
}

/** 合并写入 cheer_settings（保留未提及字段，避免 set() 整文档覆盖抹掉其他开关） */
async function patchCheerDoc(patch) {
  const col = await collection('app_config');
  const existing = await readCheerDoc();
  const next = Object.assign({}, existing || {}, patch, { updated_at: new Date().toISOString() });
  delete next._id; // _id 由 doc().set() 自行写入
  await col.doc(CHEER_DOC).set(next);
  invalidateCache(CHEER_DOC);
  return next;
}

async function setCheerDataMode(mode) {
  if (!isValidCheerDataMode(mode)) {
    throw new Error(`invalid data_mode: ${mode}`);
  }
  await patchCheerDoc({ data_mode: mode });
  return { mode, source: 'db' };
}

async function setCheerSettings(patch) {
  const body = {};
  for (const key of Object.keys(CHEER_SETTING_DEFAULTS)) {
    if (typeof patch[key] === 'boolean') body[key] = patch[key];
  }
  if (!Object.keys(body).length) {
    throw new Error('setCheerSettings: 至少提供一个布尔开关');
  }
  const saved = await patchCheerDoc(body);
  return {
    mode: saved.data_mode,
    date_context_enabled: saved.date_context_enabled !== false,
    humanize_enabled: saved.humanize_enabled !== false,
    event_context_enabled: saved.event_context_enabled !== false,
    source: 'db',
  };
}

// ── 提示词配置（v1.1.0 Task 3）：app_config/cheer_settings.prompts 子文档 ──
// 分层红线：模板措辞/数值参数进后台；JSON 格式约束、校验电池、占位符渲染器、档位计算留代码。
// 结构化默认值见 prompt-template.js DEFAULT_PROMPTS（version 0 = 未自定义，删 DB 子文档即回代码默认）。

const PROMPT_TEMPLATE_FIELDS = ['event_strong_hint', 'event_preview_hint', 'date_context_hint', 'user_text_hint'];
const PROMPT_INT_FIELDS = {
  line_count: [1, 10],
  line_min_chars: [5, 100],
  event_min_lines_preview: [0, 10],
  event_min_lines_strong: [0, 10],
  candidate_count: [1, 3],
};
// 采样惩罚参数（v1.1.0 Task 6）：浮点，OpenAI 兼容范围 0-2
const PROMPT_FLOAT_FIELDS = {
  frequency_penalty: [0, 2],
  presence_penalty: [0, 2],
};
const LINE_TARGET_RANGE_RE = /^\d{1,4}\s*-\s*\d{1,4}$/u;

/** 合并提示词配置：DB 原始值逐字段类型校验后覆盖代码默认，非法字段静默回默认（写入侧另有硬校验） */
function mergePromptConfig(raw) {
  const merged = { ...DEFAULT_PROMPTS };
  if (raw && typeof raw === 'object') {
    for (const field of PROMPT_TEMPLATE_FIELDS) {
      if (typeof raw[field] === 'string' && raw[field].trim()) merged[field] = raw[field];
    }
    for (const [field, [min, max]] of Object.entries(PROMPT_INT_FIELDS)) {
      if (Number.isInteger(raw[field]) && raw[field] >= min && raw[field] <= max) merged[field] = raw[field];
    }
    for (const [field, [min, max]] of Object.entries(PROMPT_FLOAT_FIELDS)) {
      if (typeof raw[field] === 'number' && Number.isFinite(raw[field]) && raw[field] >= min && raw[field] <= max) merged[field] = raw[field];
    }
    if (typeof raw.line_target_range === 'string' && LINE_TARGET_RANGE_RE.test(raw.line_target_range)) {
      merged.line_target_range = raw.line_target_range.replace(/\s/gu, '');
    }
    if (Array.isArray(raw.few_shot_examples)) {
      merged.few_shot_examples = raw.few_shot_examples
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().slice(0, 60))
        .slice(0, 20);
    }
    if (Number.isInteger(raw.version) && raw.version >= 1) merged.version = raw.version;
  }
  return merged;
}

/** 读取提示词配置（合并代码默认后的生效值，随 getCheerSettings 的 30s TTL 缓存） */
async function getCheerPrompts() {
  const settings = await getCheerSettings();
  return settings.prompts;
}

/**
 * 保存提示词配置（全量替换 prompts 子文档，version 自增）。
 * 校验失败抛错（error.code = 'INVALID_PROMPTS'），不落库、不 bump version。
 * @param {object} patch 与 DEFAULT_PROMPTS 同构的子集
 * @returns {object} 保存后的完整 prompts 配置（含自增后的 version）
 */
async function setCheerPrompts(patch) {
  const body = patch && typeof patch === 'object' ? patch : {};
  const current = mergePromptConfig((await readCheerDoc())?.prompts);
  const errors = [];

  for (const field of PROMPT_TEMPLATE_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string') {
      errors.push(`${field}: 必须为字符串`);
      continue;
    }
    const check = validateTemplate(body[field]);
    if (!check.ok) errors.push(`${field}: ${check.errors.join('；')}`);
  }
  for (const [field, [min, max]] of Object.entries(PROMPT_INT_FIELDS)) {
    if (body[field] === undefined) continue;
    if (!Number.isInteger(body[field]) || body[field] < min || body[field] > max) {
      errors.push(`${field}: 必须为 ${min}-${max} 的整数`);
    }
  }
  for (const [field, [min, max]] of Object.entries(PROMPT_FLOAT_FIELDS)) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < min || body[field] > max) {
      errors.push(`${field}: 必须为 ${min}-${max} 的数字`);
    }
  }
  if (body.line_target_range !== undefined
    && (typeof body.line_target_range !== 'string' || !LINE_TARGET_RANGE_RE.test(body.line_target_range))) {
    errors.push('line_target_range: 必须为 "min-max" 数字区间（如 30-50）');
  }
  if (body.few_shot_examples !== undefined) {
    if (!Array.isArray(body.few_shot_examples)) {
      errors.push('few_shot_examples: 必须为字符串数组');
    } else if (body.few_shot_examples.length > 20) {
      errors.push('few_shot_examples: 最多 20 条');
    } else if (body.few_shot_examples.some((item) => typeof item !== 'string' || !item.trim())) {
      errors.push('few_shot_examples: 每条必须为非空字符串');
    }
  }

  if (errors.length) {
    const error = new Error(`提示词配置校验失败：${errors.join('；')}`);
    error.code = 'INVALID_PROMPTS';
    throw error;
  }

  const next = mergePromptConfig({ ...current, ...body });
  next.version = (current.version || 0) + 1;
  await patchCheerDoc({ prompts: next });
  return next;
}

/** 删除 prompts 子文档 → 回代码默认模板（version 归 0），下一次生成即生效 */
async function resetCheerPrompts() {
  const col = await collection('app_config');
  const existing = await readCheerDoc();
  if (existing && existing.prompts !== undefined) {
    const next = { ...existing };
    delete next.prompts;
    delete next._id;
    next.updated_at = new Date().toISOString();
    await col.doc(CHEER_DOC).set(next);
    invalidateCache(CHEER_DOC);
  }
  return { ...DEFAULT_PROMPTS };
}

// ── 调度配置 ──

async function getSchedulerSettings() {
  const cached = readCache(SCHEDULER_DOC);
  if (cached) return cached;

  const defaults = {
    weekly_story_enabled: config.weeklyStoryEnabled,
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
    updated_at: new Date().toISOString(),
  });
  delete next._id; // _id 由 doc().set() 自行写入，避免重复
  await col.doc(SCHEDULER_DOC).set(next);
  invalidateCache(SCHEDULER_DOC);
  return Object.assign({}, next, { source: 'db' });
}

// ── 应援事件表（cheer_events 集合，每事件一个 doc）──

const EVENT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TYPES = ['gold_medal', 'match', 'festival'];

/** 全量事件（带 TTL 缓存）；admin 展示与热路径共用一份 */
async function getAllCheerEvents() {
  const cached = readCache(EVENTS_COLLECTION);
  if (cached) return cached;
  const col = await collection(EVENTS_COLLECTION);
  const result = await col.orderBy('date', 'asc').get();
  const list = result.data || []; // 保留 _id，admin 编辑/删除需定位
  writeCache(EVENTS_COLLECTION, list);
  return list;
}

async function getCheerEvents() {
  return getAllCheerEvents();
}

/**
 * 命中日期窗口的事件（active + resolveEventPhase 三档过滤），按剩余天数升序。
 * @param {string} date 'YYYY-MM-DD'
 * @returns {Array<object>} 每个元素为 { ...event, phase }
 */
async function getActiveEventsForDate(date) {
  const list = await getAllCheerEvents();
  const hits = [];
  for (const ev of list) {
    if (ev.active === false) continue;
    const phase = resolveEventPhase(ev, date);
    if (phase) hits.push(Object.assign({}, ev, { phase }));
  }
  hits.sort((a, b) => a.phase.daysUntil - b.phase.daysUntil);
  return hits;
}

/** upsert 事件，_id 幂等；leadDays 缺省 30（0 = 仅当天） */
async function setCheerEvent(event) {
  if (!event || typeof event.date !== 'string' || !EVENT_DATE_RE.test(event.date)) {
    throw new Error('invalid event: date 必须为 YYYY-MM-DD');
  }
  const title = typeof event.title === 'string' ? event.title.trim() : '';
  if (!title) throw new Error('invalid event: title 必填');

  const id = typeof event._id === 'string' && event._id ? event._id : `event_${event.date}_${Date.now()}`;
  const doc = {
    _id: id,
    date: event.date,
    title,
    leadDays: Number.isInteger(event.leadDays) && event.leadDays >= 0 ? event.leadDays : 30,
    type: EVENT_TYPES.includes(event.type) ? event.type : 'match',
    description: typeof event.description === 'string' ? event.description : '',
    refs_label: typeof event.refs_label === 'string' && event.refs_label.trim()
      ? event.refs_label.trim() : '今日赛事',
    refs_value: typeof event.refs_value === 'string' && event.refs_value.trim()
      ? event.refs_value.trim() : title,
    active: typeof event.active === 'boolean' ? event.active : true,
    created_at: event.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const col = await collection(EVENTS_COLLECTION);
  await col.doc(id).set(doc);
  invalidateCache(EVENTS_COLLECTION);
  return doc;
}

async function deleteCheerEvent(id) {
  if (typeof id !== 'string' || !id) throw new Error('invalid event id');
  const col = await collection(EVENTS_COLLECTION);
  await col.doc(id).remove();
  invalidateCache(EVENTS_COLLECTION);
  return { id };
}

module.exports = {
  CHEER_DATA_MODES,
  isValidCheerDataMode,
  getCheerDataMode,
  setCheerDataMode,
  getCheerSettings,
  setCheerSettings,
  getCheerPrompts,
  setCheerPrompts,
  resetCheerPrompts,
  getSchedulerSettings,
  setSchedulerSettings,
  getCheerEvents,
  getActiveEventsForDate,
  setCheerEvent,
  deleteCheerEvent,
};
