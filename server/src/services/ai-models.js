'use strict';

/**
 * AI 模型列表拉取服务（OpenAI 兼容 /models 约定）
 *
 * 设计要点：
 * - 入参 {baseUrl, apiKey} 均可缺省，缺省时回退到 getEffectiveConfig()（已保存/环境变量）。
 * - 仅当表单 Base URL 与当前生效 Base URL 相同（或未填写）时才复用已保存 key；
 *   用户填写不同 Base URL 但未填 key 时，抛 KEY_REQUIRED_FOR_NEW_ENDPOINT，避免把旧 key 发给新供应商。
 * - URL 归一化 + SSRF 防护：仅允许 http/https，清空 query/hash，去除尾斜杠与 /chat/completions 后缀，
 *   拒绝 localhost/环回/私网/link-local 地址与已含 /models 的 URL。
 * - 响应体与模型数量设置上限，避免异常端点造成内存/资源消耗。
 */

const aiConfig = require('./ai-config');
const dns = require('node:dns').promises;

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB 响应上限
const MAX_MODELS = 1000; // 模型数量上限

/**
 * 解析并校验目标地址，返回拼接好的 /models URL；非法/危险地址抛出带 code 的错误。
 */
function resolveModelsUrl(rawBaseUrl) {
  if (!rawBaseUrl || !String(rawBaseUrl).trim()) {
    const e = new Error('Base URL 未配置');
    e.code = 'NO_BASE_URL';
    throw e;
  }

  let url;
  try {
    url = new URL(String(rawBaseUrl).trim());
  } catch {
    const e = new Error('Base URL 格式非法');
    e.code = 'INVALID_URL';
    throw e;
  }

  // 仅允许 http / https
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const e = new Error('仅支持 http/https 协议');
    e.code = 'INVALID_URL';
    throw e;
  }

  // SSRF 防护：拒绝访问本地/内网地址
  if (isPrivateOrLocalhost(url.hostname)) {
    const e = new Error('出站地址被拒绝（不允许访问本地或内网地址）');
    e.code = 'SSRF_BLOCKED';
    throw e;
  }

  // 清空 query / hash
  url.search = '';
  url.hash = '';

  // 去除尾部斜杠
  let path = url.pathname.replace(/\/+$/, '');

  // 去除 /chat/completions 后缀
  path = path.replace(/\/chat\/completions$/i, '');

  // 拒绝已经包含 /models 的地址（避免拼接成 /models/models）
  if (/(^|\/|%2f)models(\/|$)/i.test(path)) {
    const e = new Error('Base URL 不应包含 /models 路径');
    e.code = 'INVALID_URL';
    throw e;
  }

  return url.origin + path + '/models';
}

/**
 * 判断 hostname 是否为本地/内网/保留地址（SSRF 防护）。
 * 仅对字面量 IP 与 known host 做同步判定，便于在无网络环境下确定性测试。
 */
function isPrivateOrLocalhost(hostname) {
  if (!hostname) return true;
  const h = String(hostname).toLowerCase();

  // localhost / .localhost / .internal
  if (h === 'localhost' || h.endsWith('.localhost') || h.includes('.internal')) return true;

  // IPv4 字面量
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = +ipv4[1], b = +ipv4[2], c = +ipv4[3], d = +ipv4[4];
    if ([a, b, c, d].some((x) => x > 255 || Number.isNaN(x))) return false; // 非法字面量，交给下游 fetch 失败
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // 环回
    if (a === 10) return true; // 私网 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网 172.16/12
    if (a === 192 && b === 168) return true; // 私网 192.168/16
    if (a === 169 && b === 254) return true; // 链路本地 / 云元数据 169.254/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }

  // IPv6 字面量（[...] 形式）
  if (h.startsWith('[') || h.includes(':')) {
    const v6 = h.replace(/^\[/, '').replace(/\]$/, '').toLowerCase().split('%')[0];
    if (v6 === '::1' || v6 === '::') return true; // 环回 / 未指定
    if (v6.startsWith('fe80')) return true; // 链路本地
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // 唯一本地地址
    return false;
  }

  // 非字面量域名：不在此同步判定（交给下游 fetch 的超时/失败兜底）
  return false;
}

async function assertResolvedPublicHost(hostname) {
  if (isPrivateOrLocalhost(hostname)) return;
  // 防止域名解析到内网地址；fetch 禁止自动重定向以避免绕过此检查。
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    const err = new Error(`DNS 解析失败: ${hostname}`);
    err.code = 'DNS_LOOKUP_FAILED';
    err.cause = e;
    throw err;
  }
  if (!records.length || records.some((r) => isPrivateOrLocalhost(r.address))) {
    const err = new Error('出站地址被拒绝（域名解析到本地或内网地址）');
    err.code = 'SSRF_BLOCKED';
    throw err;
  }
}

/**
 * 读取响应体并限制最大字节数，避免异常端点耗尽内存。
 */
async function readCappedBody(resp) {
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      const e = new Error('响应体过大（超过 ' + MAX_RESPONSE_BYTES + ' 字节），已拒绝');
      e.code = 'RESPONSE_TOO_LARGE';
      throw e;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * 拉取某端点可用模型（OpenAI 兼容 /models 约定）
 * @param {{baseUrl?:string, apiKey?:string}} [opts]
 * @returns {Promise<{ok:boolean, models?:string[], endpoint?:string, error?:string}>}
 */
async function fetchAvailableModels(opts = {}) {
  const { baseUrl, apiKey } = opts || {};
  const cfg = aiConfig.getEffectiveConfig();

  const resolvedBaseUrl = baseUrl || cfg.baseUrl;
  // 是否使用了「不同的端点」：表单显式填了且与生效 Base URL 不一致
  const isNewEndpoint = !!(
    baseUrl &&
    String(baseUrl).trim() &&
    String(baseUrl).trim() !== (cfg.baseUrl || '')
  );

  // 仅当不是新端点（未填 URL 或与当前相同）时才复用已保存 key
  const resolvedKey = apiKey || (isNewEndpoint ? null : cfg.apiKey);

  if (!resolvedKey) {
    if (isNewEndpoint) {
      const e = new Error('检测到新的 API 地址，请填写对应的 API Key');
      e.code = 'KEY_REQUIRED_FOR_NEW_ENDPOINT';
      throw e;
    }
    const e = new Error('API Key 未配置');
    e.code = 'NO_KEY';
    throw e;
  }

  const modelsUrl = resolveModelsUrl(resolvedBaseUrl);

  try {
    const target = new URL(modelsUrl);
    await assertResolvedPublicHost(target.hostname);
    const resp = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${resolvedKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });

    const text = await readCappedBody(resp);
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON 视为失败 */ }

    if (resp.ok && body && Array.isArray(body.data)) {
      let models = body.data
        .map((it) => (typeof it === 'string' ? it : it?.id))
        .filter((id) => id && typeof id === 'string');
      if (models.length > MAX_MODELS) {
        models = models.slice(0, MAX_MODELS);
      }
      return { ok: true, models, endpoint: modelsUrl };
    }

    const msg = body?.error?.message || `Unexpected response (HTTP ${resp.status})`;
    return { ok: false, error: msg, endpoint: modelsUrl };
  } catch (e) {
    if (e.code === 'NO_KEY' || e.code === 'KEY_REQUIRED_FOR_NEW_ENDPOINT') throw e;
    let msg = e.message;
    if (e.cause) {
      if (e.cause.code === 'ENOTFOUND') msg = `DNS 解析失败: ${e.cause.hostname || modelsUrl}`;
      else if (e.cause.code === 'ECONNREFUSED') msg = `连接被拒绝: ${modelsUrl}`;
      else if (e.cause.code === 'ETIMEDOUT' || e.cause.name === 'TimeoutError') msg = `连接超时: ${modelsUrl}`;
      else msg = `${e.cause.code || ''}: ${e.message}`.trim();
    }
    return { ok: false, error: msg, endpoint: modelsUrl };
  }
}

module.exports = { fetchAvailableModels, resolveModelsUrl, isPrivateOrLocalhost };
