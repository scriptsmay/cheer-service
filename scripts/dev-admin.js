#!/usr/bin/env node
/* ============================================================
 * dev-admin.js — 本地调试管理后台（前端本地，后端走线上）
 *
 * 场景：想本地改/看 server/public/admin.html(+css+js)，
 *       但调用线上后端 https://api.kplwuyan.site/api。
 *
 * 原理：起一个本地 HTTP 服务——
 *   - /admin-static/*  -> 读取 server/public/*（同源静态资源）
 *   - / 与 /admin.html -> 返回 admin.html
 *   - /api/**          -> 反向代理到 ${API_TARGET}（默认线上）
 * 浏览器全程访问 http://localhost:<PORT>，属于同源请求，
 * 因此 admin.js 里所有相对路径 /api/... 无需任何改动，
 * 也不存在浏览器 CORS 问题（代理在 Node 端转发）。
 *
 * 零依赖：仅用 Node 内置 http / https / fs / path。
 *
 * 用法：
 *   node scripts/dev-admin.js
 *   PORT=9000 API_TARGET=https://api.kplwuyan.site node scripts/dev-admin.js
 * 然后浏览器打开 http://localhost:8787/
 * ============================================================ */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8787;
const API_TARGET = process.env.API_TARGET || 'https://api.kplwuyan.site';
// 仅取 host，路径里的 /api 由 req.url 原样带上
const TARGET_HOST = API_TARGET.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

const PUBLIC_DIR = path.join(__dirname, '..', 'server', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(urlPath, res) {
  // /admin-static/admin.js -> public/admin.js
  let rel = urlPath.startsWith('/admin-static/')
    ? urlPath.slice('/admin-static/'.length)
    : urlPath.replace(/^\/+/, '');
  if (rel === '' || rel === 'admin.html') rel = 'admin.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found: ' + rel); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function proxyApi(req, res) {
  const headers = { ...req.headers };
  delete headers.host;       // 让目标服务器自己决定 Host
  delete headers.connection;

  const proxyReq = https.request(
    {
      method: req.method,
      hostname: TARGET_HOST,
      path: req.url, // 已包含 /api/...
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy_error', detail: e.message, target: TARGET_HOST + req.url }));
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    proxyApi(req, res);
    return;
  }
  serveStatic(req.url, res);
});

server.listen(PORT, () => {
  console.log(`admin dev server:  http://localhost:${PORT}/`);
  console.log(`proxy /api/*   ->  https://${TARGET_HOST}/api/...`);
  console.log('（仅本地调试用，前端/后端代码均无需改动）');
});
