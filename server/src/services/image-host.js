'use strict';

/**
 * EasyImage2 图床转存 — Admin 上传中转使用
 *
 * 契约：POST {base}/api/index.php，multipart 字段 image（文件）+ token。
 * 成功条件 result === 'success' 且 code === 200，返回 url / thumb。
 * token 与返回的 del（删除凭据）都不得写日志或落库。
 */

const config = require('../config/env');

const UPLOAD_TIMEOUT_MS = 30 * 1000;

function imageHostError(message) {
  const error = new Error(message);
  error.code = 'IMAGE_HOST_ERROR';
  return error;
}

/**
 * @param {Buffer} buffer 文件内容
 * @param {string} filename 原始文件名
 * @param {string} mimetype MIME 类型
 * @returns {Promise<{ url: string, thumbUrl: string, srcName: string }>}
 */
async function uploadToImageHost(buffer, filename, mimetype) {
  if (!config.easyimageToken) {
    const error = new Error('EASYIMAGE_TOKEN 未配置，无法转存图床');
    error.code = 'IMAGE_HOST_NOT_CONFIGURED';
    throw error;
  }

  const form = new FormData();
  const blob = new Blob([buffer], { type: mimetype || 'application/octet-stream' });
  form.append('image', blob, filename || 'material.jpg');
  form.append('token', config.easyimageToken.trim());

  let response;
  try {
    response = await fetch(`${config.easyimageBaseUrl}/api/index.php`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw imageHostError(`图床请求失败: ${error.message}`);
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw imageHostError(`图床返回非 JSON（HTTP ${response.status}）`);
  }

  if (!response.ok || payload.result !== 'success' || Number(payload.code) !== 200) {
    throw imageHostError(payload.message || `图床上传失败（HTTP ${response.status} / code ${payload.code}）`);
  }

  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  if (!url) throw imageHostError('图床未返回图片直链');
  const thumbUrl = typeof payload.thumb === 'string' ? payload.thumb.trim() : '';

  return {
    url,
    thumbUrl,
    srcName: typeof payload.srcName === 'string' ? payload.srcName : (filename || ''),
  };
}

/**
 * 由图床原图地址派生落库用图：卡片图对齐 1080×1440 画布，列表缩略图 3:4。
 * 非 /i/ 路径无法走 thumb.php，返回 null 由调用方回落原图。
 */
function buildMaterialImageUrls(originalUrl) {
  let path;
  try {
    path = new URL(originalUrl).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith('/i/')) return null;
  const base = config.easyimageBaseUrl;
  return {
    url: `${base}/app/thumb.php?img=${path}&w=1080&q=82`,
    thumbUrl: `${base}/app/thumb.php?img=${path}&w=258&h=344&q=80`,
  };
}

module.exports = { uploadToImageHost, buildMaterialImageUrls };
