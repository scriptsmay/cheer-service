'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');

test('AI view exposes a read-only statistics panel and window selector', () => {
  assert.match(html, /id="aiStats"/);
  assert.match(html, /id="aiStatsWindow"/);
  assert.match(html, /data-window="24h"/);
  assert.match(html, /data-window="7d"/);
  assert.match(html, /data-window="30d"/);
  assert.match(html, /只读统计/);
  assert.doesNotMatch(html.slice(html.indexOf('id="aiStats"'), html.indexOf('id="saveConfigBtn"')), /保存|切换模型|修改模型/);
});

test('AI statistics script requests the selected window and renders escaped model rows', () => {
  assert.match(js, /\/api\/admin\/ai\/stats\?window=/);
  assert.match(js, /aiStats/);
  assert.match(js, /aiStatsWindow/);
  assert.match(js, /success_rate/);
  assert.match(js, /p50_ms/);
  assert.match(js, /p95_ms/);
  assert.match(js, /validation_failures/);
  assert.match(js, /escapeHtml\(/);
  assert.match(js, /暂无统计样本/);
  assert.match(js, /aiStatsWindow[\s\S]{0,80}addEventListener/);
});

test('materials view exposes upload/link forms, filters and focus editor', () => {
  assert.match(html, /data-route="materials"/);
  assert.match(html, /id="view-materials"/);
  assert.match(html, /id="materialGrid"/);
  assert.match(html, /id="materialCount"/);
  assert.match(html, /id="matUploadForm"/);
  assert.match(html, /id="matLinkForm"/);
  assert.match(html, /id="matFile" type="file" accept="image\/\*"/);
  assert.match(html, /id="matFilterCategory"/);
  assert.match(html, /id="matFilterEnabled"/);
  assert.match(html, /id="focusMask"/);
  assert.match(html, /id="focusRange"/);
  assert.match(html, /id="focusImg"/);
  assert.match(html, /文案安全区/);
});

test('materials script uses admin API, multipart upload and escaped rows', () => {
  assert.match(js, /\/api\/admin\/materials/);
  assert.match(js, /thumb_url/);
  assert.match(js, /new FormData\(\)/);
  assert.match(js, /form\.append\('image'/);
  assert.match(js, /Authorization/);
  assert.match(js, /focus_y/);
  assert.match(js, /审核通过/);
  assert.match(js, /escapeHtml\(/);
  assert.match(js, /data-mat-mode/);
});
