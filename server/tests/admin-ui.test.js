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
