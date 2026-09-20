'use strict';

/**
 * pg-filter — mongo.js where() 过滤器 → Postgres JSONB 条件翻译层（纯函数）
 *
 * v1.3.0 迁移 Phase 2 前置件：postgres.js 适配器（对标 db/mongo.js TCB 兼容面）的
 * 查询条件核心。业务代码全量摸底（2026-09-21）实际使用的操作符面：
 *   等值匹配（普遍）· command.gte / command.lte / command.neq（ISO 字符串与状态）· { $exists }
 * 字符串字段比较走文本序（ISO 时间戳天然有序）；文档存 data jsonb，_id 独立列。
 * 字段名经白名单校验后内插，值一律参数化。
 */

const COMPARISON_OPS = { $gte: '>=', $lte: '<=', $gt: '>', $lt: '<' };

function assertFieldName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`pg-filter: 非法字段名 ${JSON.stringify(name)}`);
  }
  return name;
}

function isOperatorObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

/**
 * 把 mongo 风格 filter 翻译为 JSONB WHERE 片段
 * @param {object} filter 例：{ subject_id: 'x', created_at: { $gte: iso }, event_hit: { $exists: true } }
 * @param {string} [column='data'] jsonb 列名
 * @returns {{sql: string, params: any[]}} 空过滤器 → { sql: 'TRUE', params: [] }
 */
function buildWhere(filter, column = 'data') {
  const params = [];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const jsonb = (v) => `${p(JSON.stringify(v === undefined ? null : v))}::jsonb`;
  const parts = [];

  for (const key of Object.keys(filter || {})) {
    assertFieldName(key);
    const value = filter[key];
    const ref = `${column}->'${key}'`;

    if (isOperatorObject(value)) {
      for (const op of Object.keys(value)) {
        const v = value[op];
        if (op === '$exists') {
          parts.push(v ? `${column} ? ${p(key)}` : `NOT ${column} ? ${p(key)}`);
        } else if (op === '$ne' || op === '$eq') {
          parts.push(op === '$ne' ? `${ref} IS DISTINCT FROM ${jsonb(v)}` : `${ref} = ${jsonb(v)}`);
        } else if (COMPARISON_OPS[op]) {
          parts.push(`(${ref}) ${COMPARISON_OPS[op]} ${jsonb(v)}`);
        } else if (op === '$in') {
          if (!Array.isArray(v)) throw new Error('pg-filter: $in 需要数组');
          parts.push(`${ref} = ANY(${p(JSON.stringify(v))}::jsonb[])`);
        } else {
          throw new Error(`pg-filter: 不支持的操作符 ${op}（字段 ${key}）`);
        }
      }
    } else {
      parts.push(`${ref} = ${jsonb(value)}`);
    }
  }

  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

module.exports = { buildWhere };
