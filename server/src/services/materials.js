'use strict';

/**
 * 素材库服务 — cheer_materials 集合
 *
 * 每条素材一个 doc，字段见 plans/cheer-card-photo-bg-materials-design。
 * 公开链路只读启用条目；Admin 链路可增删改并查看全部。
 * 30s 进程内 TTL 缓存，写操作立即失效，避免前端防抖重绘反复打库。
 */

const crypto = require('crypto');
const { collection } = require('../db');

const MATERIALS_COLLECTION = 'cheer_materials';
const CACHE_TTL_MS = 30 * 1000;

const MATERIAL_CATEGORIES = ['单人照', 'MVP卡片', '赛场返图'];
const MATERIAL_SOURCES = ['weibo_personal', 'admin_upload', 'match_mvp'];
const DEFAULT_CATEGORY = '单人照';
const DEFAULT_ALBUM = '无言';
const DEFAULT_SOURCE = 'admin_upload';

let cache = null;

function readCache() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.value;
  return null;
}

function writeCache(value) {
  cache = { value, ts: Date.now() };
}

function invalidateCache() {
  cache = null;
}

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  return error;
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeFocusY(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

function normalizeText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeCategory(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CATEGORY;
  if (!MATERIAL_CATEGORIES.includes(value)) {
    throw validationError(`category 必须是 ${MATERIAL_CATEGORIES.join(' / ')} 之一`);
  }
  return value;
}

function normalizeSource(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SOURCE;
  if (!MATERIAL_SOURCES.includes(value)) {
    throw validationError(`source 必须是 ${MATERIAL_SOURCES.join(' / ')} 之一`);
  }
  return value;
}

function generateMaterialId(url) {
  const digest = crypto.createHash('sha256').update(url).digest('hex').slice(0, 8);
  return `mat_${Date.now()}_${digest}`;
}

function normalizeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value)) {
    throw validationError('_id 只能是 1-96 位字母、数字、下划线或连字符');
  }
  return value;
}

/** 全量素材（带 TTL 缓存），按创建时间倒序 */
async function getAllMaterials() {
  const cached = readCache();
  if (cached) return cached;
  const col = await collection(MATERIALS_COLLECTION);
  const result = await col.orderBy('created_at', 'desc').get();
  const list = result.data || [];
  writeCache(list);
  return list;
}

/** 公开列表 — 仅启用素材，按分类 / 相册过滤，输出渲染所需字段 */
async function listPublicMaterials(filters = {}) {
  const category = filters.category;
  const album = filters.album;
  const list = await getAllMaterials();
  return list
    .filter((item) => item.enabled === true)
    .filter((item) => (category ? item.category === category : true))
    .filter((item) => (album ? item.album === album : true))
    .map((item) => ({
      _id: item._id,
      url: item.url,
      thumb_url: item.thumb_url || '',
      category: item.category,
      album: item.album,
      focus_y: typeof item.focus_y === 'number' ? item.focus_y : 0.5,
      created_at: item.created_at,
    }));
}

/** Admin 列表 — 全量（含待审核），可选 enabled 过滤 */
async function listAllMaterials(filters = {}) {
  const category = filters.category;
  const album = filters.album;
  const enabled = filters.enabled;
  const list = await getAllMaterials();
  return list
    .filter((item) => (category ? item.category === category : true))
    .filter((item) => (album ? item.album === album : true))
    .filter((item) => (typeof enabled === 'boolean' ? item.enabled === enabled : true));
}

async function getMaterial(id) {
  if (typeof id !== 'string' || !id) return null;
  const col = await collection(MATERIALS_COLLECTION);
  const result = await col.doc(id).get();
  return (result.data && result.data[0]) || null;
}

/**
 * 新增素材；_id 可由调用方给出（抓图脚本按 source_url hash 幂等重放），
 * 已存在时直接返回原记录，不覆盖人工审核结果。
 */
async function createMaterial(input) {
  const body = input && typeof input === 'object' ? input : {};
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!isHttpUrl(url)) throw validationError('url 必须为 http(s) 图片直链');

  const thumbUrl = typeof body.thumb_url === 'string' ? body.thumb_url.trim() : '';
  if (thumbUrl && !isHttpUrl(thumbUrl)) throw validationError('thumb_url 必须为 http(s) 直链');

  const id = body._id !== undefined ? normalizeId(body._id) : generateMaterialId(url);

  const existing = await getMaterial(id);
  if (existing) return existing;

  const now = new Date().toISOString();
  const doc = {
    _id: id,
    url,
    thumb_url: thumbUrl,
    category: normalizeCategory(body.category),
    album: normalizeText(body.album, DEFAULT_ALBUM),
    source: normalizeSource(body.source),
    source_url: normalizeText(body.source_url, url),
    focus_y: normalizeFocusY(body.focus_y),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
    created_at: now,
    updated_at: now,
  };

  const col = await collection(MATERIALS_COLLECTION);
  await col.doc(id).set(doc);
  invalidateCache();
  return doc;
}

/** 更新素材元数据；仅接受白名单字段 */
async function updateMaterial(id, patch) {
  const existing = await getMaterial(id);
  if (!existing) {
    const error = new Error('素材不存在');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const body = patch && typeof patch === 'object' ? patch : {};
  const next = { ...existing };

  if (body.url !== undefined) {
    if (!isHttpUrl(body.url)) throw validationError('url 必须为 http(s) 图片直链');
    next.url = body.url.trim();
  }
  if (body.thumb_url !== undefined) {
    const thumbUrl = typeof body.thumb_url === 'string' ? body.thumb_url.trim() : '';
    if (thumbUrl && !isHttpUrl(thumbUrl)) throw validationError('thumb_url 必须为 http(s) 直链');
    next.thumb_url = thumbUrl;
  }
  if (body.category !== undefined) next.category = normalizeCategory(body.category);
  if (body.album !== undefined) next.album = normalizeText(body.album, DEFAULT_ALBUM);
  if (body.source !== undefined) next.source = normalizeSource(body.source);
  if (body.source_url !== undefined) next.source_url = normalizeText(body.source_url, existing.source_url || '');
  if (body.focus_y !== undefined) next.focus_y = normalizeFocusY(body.focus_y);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw validationError('enabled 必须是布尔值');
    next.enabled = body.enabled;
  }
  next.updated_at = new Date().toISOString();

  const col = await collection(MATERIALS_COLLECTION);
  await col.doc(String(id)).set(next);
  invalidateCache();
  return next;
}

/** 删除素材（仅 DB 记录，图床文件保留） */
async function deleteMaterial(id) {
  const existing = await getMaterial(id);
  if (!existing) {
    const error = new Error('素材不存在');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const col = await collection(MATERIALS_COLLECTION);
  await col.doc(String(id)).remove();
  invalidateCache();
  return { _id: String(id) };
}

module.exports = {
  MATERIAL_CATEGORIES,
  MATERIAL_SOURCES,
  invalidateCache,
  listPublicMaterials,
  listAllMaterials,
  getMaterial,
  createMaterial,
  updateMaterial,
  deleteMaterial,
};
