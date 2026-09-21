'use strict';

/**
 * AI 模型列表拉取服务（OpenAI 兼容 /models 约定）
 *
 * 设计要点：
 * - 入参 {baseUrl, apiKey} 均可缺省，缺省时回退到 getEffectiveConfig()（已保存/环境变量）。
 * - 仅当表单 Base URL 与当前生效 Base URL 相同（或未填写）时才复用已保存 key；
 *   用户填写不同 Base URL 但未填 key 时，抛 KEY_REQUIRED_FOR_NEW_ENDPOINT，避免把旧 key 发给新供应商。
 * - URL 归一化 + SSRF 防护：仅允许 http/https，清空 query/hash，去除尾斜杠与 /chat/completions 后缀，
 *   拒绝 localhost/环回/私网/link-local 地址（含 IPv4-mapped IPv6）与已含 /models 的 URL。
 * - DNS rebinding 防护：对域名只做一次解析并校验全部结果，随后直接对解析出的 IP 建连
 *   （Host 头与 TLS SNI 保留原域名），消除「校验用一次解析、请求再用一次解析」之间的窗口。
 * - 响应体与模型数量设置上限，避免异常端点造成内存/资源消耗。
 */

const aiConfig = require('./ai-config');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');

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
 * 判断 IPv4 字面量是否为本地/内网/保留地址。
 * 非法字面量（段 >255）返回 false，交给下游建连失败兜底。
 */
function isPrivateIpv4Literal(h) {
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false; // 非 IPv4 字面量，由调用方继续判定
  const [a, b, c, d] = [+ipv4[1], +ipv4[2], +ipv4[3], +ipv4[4]];
  if ([a, b, c, d].some((x) => x > 255 || Number.isNaN(x))) return false; // 非法字面量，交给下游连接失败
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // 环回
  if (a === 10) return true; // 私网 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网 172.16/12
  if (a === 192 && b === 168) return true; // 私网 192.168/16
  if (a === 169 && b === 254) return true; // 链路本地 / 云元数据 169.254/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
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
  if (isPrivateIpv4Literal(h)) return true;

  // IPv6 字面量（[...] 形式）
  if (h.startsWith('[') || h.includes(':')) {
    const v6 = h.replace(/^\[/, '').replace(/\]$/, '').split('%')[0].toLowerCase();
    if (v6 === '::1' || v6 === '::') return true; // 环回 / 未指定
    // IPv4-mapped IPv6（::ffff:a.b.c.d 或 ::ffff:aabb:ccdd）→ 还原为 IPv4 复用私网判定，
    // 否则 ::ffff:127.0.0.1 这类地址会被误判为公网
    const mappedDotted = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
    if (mappedDotted) return isPrivateIpv4Literal(mappedDotted[1]);
    const mappedHex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateIpv4Literal(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (v6.startsWith('fe80')) return true; // 链路本地
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // 唯一本地地址
    return false;
  }

  // 非字面量域名：不在此同步判定（交给下游解析后的逐条校验）
  return false;
}

/**
 * 解析目标域名并校验全部结果为公网地址，返回解析记录。
 * 调用方必须使用返回的 IP 直连（Host 头与 TLS SNI 保留原域名）：
 * 校验与建连共用同一次解析结果，才没有 DNS rebinding 窗口。
 */
async function resolvePublicAddresses(hostname) {
  if (isPrivateOrLocalhost(hostname)) {
    const e = new Error('出站地址被拒绝（不允许访问本地或内网地址）');
    e.code = 'SSRF_BLOCKED';
    throw e;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    const e = new Error(`DNS 解析失败: ${hostname}`);
    e.code = 'DNS_LOOKUP_FAILED';
    e.cause = err;
    throw e;
  }
  if (!records.length || records.some((r) => isPrivateOrLocalhost(r.address))) {
    const e = new Error('出站地址被拒绝（域名解析到本地或内网地址）');
    e.code = 'SSRF_BLOCKED';
    throw e;
  }
  return records;
}

/**
 * 用已解析的 IP 直连目标（GET），保留原 Host 头与 TLS SNI。
 * node http/https 不会对 IP host 再做 DNS 解析，因此与校验用的是同一次解析结果。
 * 证书校验仍按原域名（servername），不会被指向 IP 的伪造证书绕过。
 */
function requestViaAddress(modelsUrl, address, { headers = {}, timeoutMs = 15000 } = {}) {
  const target = new URL(modelsUrl);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host: address,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { ...headers, Host: target.host },
      servername: isHttps ? target.hostname : undefined,
      timeout: timeoutMs,
    }, (res) => resolve(res));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 读取响应体并限制最大字节数，避免异常端点耗尽内存（node http 响应流版）。
 */
function readCappedBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    res.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) {
        res.destroy();
        const e = new Error('响应体过大（超过 ' + MAX_RESPONSE_BYTES + ' 字节），已拒绝');
        e.code = 'RESPONSE_TOO_LARGE';
        reject(e);
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    res.on('error', reject);
  });
}
/**
 * 拉取某端点可用模型（OpenAI 兼容 /models 约定）
 * @param {{baseUrl?:string, apiKey?:string}} [opts]
 * @returns {Promise<{ok:boolean, models?:string[], endpoint?:string, error?:string}>}
 */
async function fetchAvailableModels(opts = {}) {
  const { baseUrl, apiKey } = opts || {};
  const cfg = await aiConfig.getEffectiveConfig();

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
    // 单次解析 + 校验全部结果，随后对解析出的 IP 直连（防 DNS rebinding）
    const records = await resolvePublicAddresses(target.hostname);
    const res = await impl.requestViaAddress(modelsUrl, records[0].address, {
      headers: { Authorization: `Bearer ${resolvedKey}` },
      timeoutMs: 15000,
    });

    // 重定向一律拒绝：跟随重定向会对 Location 重新解析建连，绕过上面的校验
    if (res.statusCode >= 300 && res.statusCode < 400) {
      res.resume();
      return { ok: false, error: '端点返回重定向，已拒绝', endpoint: modelsUrl };
    }

    const text = await readCappedBody(res);
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON 视为失败 */ }

    if (res.statusCode >= 200 && res.statusCode < 300 && body && Array.isArray(body.data)) {
      let models = body.data
        .map((it) => (typeof it === 'string' ? it : it?.id))
        .filter((id) => id && typeof id === 'string');
      if (models.length > MAX_MODELS) {
        models = models.slice(0, MAX_MODELS);
      }
      return { ok: true, models, endpoint: modelsUrl };
    }

    const msg = body?.error?.message || `Unexpected response (HTTP ${res.statusCode})`;
    return { ok: false, error: msg, endpoint: modelsUrl };
  } catch (e) {
    if (e.code === 'NO_KEY' || e.code === 'KEY_REQUIRED_FOR_NEW_ENDPOINT') throw e;
    let msg = e.message;
    const causeCode = (e.cause && e.cause.code) || e.code;
    if (causeCode === 'ENOTFOUND') msg = `DNS 解析失败: ${(e.cause && e.cause.hostname) || modelsUrl}`;
    else if (causeCode === 'ECONNREFUSED') msg = `连接被拒绝: ${modelsUrl}`;
    else if (causeCode === 'ETIMEDOUT' || e.name === 'TimeoutError') msg = `连接超时: ${modelsUrl}`;
    else if (e.cause) msg = `${e.cause.code || ''}: ${e.message}`.trim();
    return { ok: false, error: msg, endpoint: modelsUrl };
  }
}

// 请求实现句柄：测试通过 __test.impl 注入 mock（旧版测试注入 global.fetch，实现改为 IP 直连后不再适用）
const impl = { requestViaAddress };

module.exports = { fetchAvailableModels, resolveModelsUrl, isPrivateOrLocalhost };

// ── 导出内部函数（供测试） ──
module.exports.__test = {
  impl,
  resolvePublicAddresses,
  requestViaAddress,
  readCappedBody,
};
