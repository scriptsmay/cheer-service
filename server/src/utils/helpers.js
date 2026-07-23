'use strict';

/**
 * 工具函数 — 从 runtime.js 提取的公共工具
 * hashValue, shanghaiDate, normalizeClientId, isValidClientId 等
 */

const { createHash, randomUUID } = require('node:crypto');
const config = require('../config/env');

const DAY_MS = 24 * 60 * 60 * 1000;

function hashValue(value, salt = '') {
  return createHash('sha256').update(`${salt}:${value}`).digest('hex');
}

function shanghaiDate(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const format = (value) => {
    const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  return { date: format(now), yesterday: format(new Date(now.getTime() - DAY_MS)) };
}

function normalizeClientId(value) {
  return String(value || '').trim().slice(0, 80);
}

function isValidClientId(value) {
  return /^[a-zA-Z0-9:_-]{8,80}$/u.test(value);
}

function normalizeRequestId(value) {
  return (
    String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9:_-]/gu, '')
      .slice(0, 80) || randomUUID()
  );
}

function getRequestId(req) {
  return normalizeRequestId(
    req.headers?.['x-request-id'] ||
    req.requestId ||
    randomUUID()
  );
}

function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'] || '';
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function getHeader(req, name) {
  const headers = req.headers || {};
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
  return key && typeof headers[key] === 'string' ? headers[key] : '';
}

function formatRate(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim();
  const hasPercentSign = text.endsWith('%');
  const number = Number(hasPercentSign ? text.slice(0, -1) : text);
  if (!Number.isFinite(number)) return '';
  const percentage = hasPercentSign || number > 1 ? number : number * 100;
  return `${Number(percentage.toFixed(1))}%`;
}

function textLength(value) {
  return Array.from(String(value || '')).length;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

// 北京时间辅助函数（从 ask 移植）
const BJ_OFFSET = 8 * 60 * 60 * 1000;

function getBjDate(ts) {
  const d = ts ? new Date(ts) : new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60 * 1000;
  return new Date(utc + BJ_OFFSET);
}

function formatBjTime(startTs) {
  const d = getBjDate(startTs * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hh}:${mm}`;
}

module.exports = {
  hashValue,
  shanghaiDate,
  normalizeClientId,
  isValidClientId,
  normalizeRequestId,
  getRequestId,
  getClientIp,
  getHeader,
  formatRate,
  textLength,
  isObject,
  getErrorMessage,
  positiveInt,
  getBjDate,
  formatBjTime,
  DAY_MS,
  BJ_OFFSET,
};
