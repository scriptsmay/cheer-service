'use strict';

/**
 * AI 配置持久化存储（v1.4.0 Phase 3 双模式）
 *
 * - mongo 模式（txyun 过渡期）：/app/data/ai-config.json（历史行为，不变）
 * - postgres 模式（Vercel）：app_config 集合 `ai_config` 文档；DB 未命中时自动
 *   读取旧文件并写回 DB（自迁移，txyun 时代的 thinking_budget 等值自动进库）
 * - 两者都未命中回退环境变量
 *
 * 所有读取 API 均为 async；调用方（ai.js / ai-models.js / admin.js）已 await。
 */

const fs = require('fs');
const config = require('../config/env');
const { collection } = require('../db');

const CONFIG_PATH = '/app/data/ai-config.json';
const DOC_ID = 'ai_config';
const CACHE_TTL_MS = 5000;

let cached = null;
let cachedAt = 0;

function isDbMode() {
  return config.dbDriver === 'postgres' && Boolean(config.pgUri);
}

/** mongo 模式：读文件（带 mtime 缓存） */
function readFromFile() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    const mtimeMs = stat.mtimeMs;
    if (!cached || cachedAt !== mtimeMs) {
      cached = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      cachedAt = mtimeMs;
    }
    return cached;
  } catch {
    return null;
  }
}

/** postgres 模式：读 DB；未命中且有旧文件时自迁移 */
async function readFromDb() {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  try {
    const col = await collection('app_config');
    const result = await col.doc(DOC_ID).get();
    let stored = result.data && result.data[0];
    if (!stored) {
      const legacy = readFromFile();
      if (legacy) {
        stored = legacy; // 自迁移：旧文件值自动进库
        await col.doc(DOC_ID).set(stored);
      }
    }
    cached = stored;
    cachedAt = Date.now();
    return stored;
  } catch (e) {
    console.warn('[ai-config] DB read failed, fallback to env:', e.message);
    return null;
  }
}

/** 写入：保留已存的其余字段（如 thinking_budget），避免后台保存丢失 */
async function writeConfig(data) {
  if (isDbMode()) {
    const col = await collection('app_config');
    await col.doc(DOC_ID).set(data);
  } else {
    fs.mkdirSync(require('path').dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
  }
  cached = data;
  cachedAt = isDbMode() ? Date.now() : new Date().mtimeMs ?? Date.now();
}

/**
 * 读取当前 AI 配置
 * @returns {Promise<object|null>}
 */
async function loadConfig() {
  return isDbMode() ? readFromDb() : readFromFile();
}

/**
 * 保存 AI 配置
 * @param {{baseUrl?:string, apiKey?:string, model?:string}} patch
 */
async function saveConfig({ baseUrl, apiKey, model }) {
  const current = (await loadConfig()) || {};
  const data = { ...current, baseUrl, apiKey, model, updatedAt: new Date().toISOString() };
  await writeConfig(data);
  return data;
}

/**
 * 获取当前生效配置（存储值优先，env 兜底）
 * @returns {Promise<{baseUrl:string, apiKey:string, model:string, thinkingBudget:number|undefined, _source:string}>}
 */
async function getEffectiveConfig() {
  const stored = await loadConfig();
  const envBudget = parseInt(process.env.AI_THINKING_BUDGET || '', 10);
  return {
    baseUrl:  stored?.baseUrl || config.aiBaseUrl,
    apiKey:   stored?.apiKey  || config.aiApiKey,
    model:    stored?.model   || config.aiModel,
    thinkingBudget: Number.isFinite(stored?.thinking_budget)
      ? stored.thinking_budget
      : (Number.isFinite(envBudget) ? envBudget : undefined),
    _source:  isDbMode() ? (stored ? 'db' : 'env') : (stored ? 'file' : 'env'),
  };
}

module.exports = { loadConfig, saveConfig, getEffectiveConfig };
