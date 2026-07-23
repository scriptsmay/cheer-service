'use strict';

/**
 * AI 配置持久化存储
 *
 * 优先级：/app/data/ai-config.json（用户通过管理页面修改） > 环境变量（docker-compose 默认值）
 * 修改无需重启容器，立即生效
 */

const fs = require('fs');
const path = require('path');
const config = require('../config/env');

const CONFIG_PATH = '/app/data/ai-config.json';

let cached = null;
let cacheMtime = 0;

/**
 * 读取当前 AI 配置（优先读文件，回退 env）
 */
function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.mtimeMs !== cacheMtime || !cached) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      cached = JSON.parse(raw);
      cacheMtime = stat.mtimeMs;
    }
    return cached;
  } catch {
    return null;
  }
}

/**
 * 保存 AI 配置到持久化文件
 */
function saveConfig({ baseUrl, apiKey, model }) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = { baseUrl, apiKey, model, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
  cached = data;
  cacheMtime = Date.now();
}

/**
 * 获取当前生效的 AI 配置（合并逻辑：文件优先，env 兜底）
 */
function getEffectiveConfig() {
  const file = loadConfig();
  return {
    baseUrl:  file?.baseUrl || config.aiBaseUrl,
    apiKey:   file?.apiKey  || config.aiApiKey,
    model:    file?.model   || config.aiModel,
    _source:  file ? 'file' : 'env',
  };
}

module.exports = { loadConfig, saveConfig, getEffectiveConfig };
