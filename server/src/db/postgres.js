'use strict';

/**
 * Postgres 连接 + TCB SDK 兼容封装层（Supabase 后端，v1.3.0 迁移 Phase 2）
 *
 * 与 db/mongo.js 同款接口（collection/doc/where 链/add/runTransaction/command），
 * 业务代码经 db/index.js 门面按 DB_DRIVER 选择后端，业务逻辑零改动。
 *
 * 数据模型：每集合一张表 `<schema>.<集合名> (_id text PRIMARY KEY, data jsonb)`。
 * 文档整体存 data jsonb（_id 同时注入 data 内，对齐 mongo.js 的存储形态）；
 * 过滤条件由 pg-filter 翻译（等值/gte/lte/neq/$exists 五类业务面）；
 * orderBy 用 data->>'字段' 文本序（业务面仅 ISO 时间戳与日期字符串字段）。
 */

const { Pool } = require('pg');
const { randomBytes } = require('node:crypto');
const config = require('../config/env');
const { buildWhere } = require('./pg-filter');

const COLLECTION_NAME_RE = /^[a-z_][a-z0-9_]*$/u;
const ORDER_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

let pool;

/**
 * TLS 配置：Supabase 池化器强制 TLS。官方 CA（prod-ca-2022）未随仓分发时降级为
 * rejectUnauthorized:false——流量仍全程 TLS 加密，仅跳过服务端身份校验
 * （Supabase 官方 node-postgres 配方同款）。
 */
function sslConfig() {
  return { rejectUnauthorized: false };
}

/**
 * TLS：由 ssl 对象统一控制（TLS 加密 + 跳过服务端身份校验，Supabase 官方
 * node-postgres 配方同款）。注意不能在连接串里写 sslmode——pg-connection-string
 * 会用 URL 参数覆盖显式 ssl 对象，导致 require 被按 verify-full 处理而握手失败。
 * 连接串必须存在但不做改写。
 */
function normalizeUri(uri) {
  if (!uri) throw new Error('POSTGRES_URI 未配置（DB_DRIVER=postgres 时必填）');
  return uri;
}

function getPool(options = {}) {
  if (options.pool) return options.pool;
  if (!pool) {
    pool = new Pool({
      connectionString: normalizeUri(options.pgUri || config.pgUri),
      max: options.pgPoolMax || config.pgPoolMax,
      idleTimeoutMillis: 30000,
      ssl: sslConfig(),
    });
  }
  return pool;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** 健康检查：SELECT 1（app.js /api/health 与启动链用） */
async function ping(options = {}) {
  const result = await getPool(options).query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
}

/** 24 位 hex 字符串 id（对齐 ObjectId 形态；业务主键本就是 hash/uuid 字符串） */
function generateId() {
  return randomBytes(12).toString('hex');
}

function makeBackend(executor, options = {}) {
  const schema = options.schema || config.pgSchema;
  const tableOf = (name) => {
    if (typeof name !== 'string' || !COLLECTION_NAME_RE.test(name)) {
      throw new Error(`postgres: 非法集合名 ${JSON.stringify(name)}`);
    }
    return `"${schema}"."${name}"`;
  };
  const sortClause = (sort) => {
    if (!sort || !Object.keys(sort).length) return '';
    const keys = Object.keys(sort).map((field) => {
      if (!ORDER_FIELD_RE.test(field)) throw new Error(`postgres: 非法排序字段 ${JSON.stringify(field)}`);
      return `data->>'${field}' ${sort[field] === -1 ? 'DESC' : 'ASC'}`;
    });
    return ` ORDER BY ${keys.join(', ')}`;
  };
  const pageClause = (limitN, skipN) => {
    let clause = '';
    if (limitN != null) clause += ` LIMIT ${Number(limitN)}`;
    if (skipN) clause += ` OFFSET ${Number(skipN)}`;
    return clause;
  };

  // ── 链式查询构造器（与 mongo.js 行为一致：where/orderBy/limit/skip 同步链，get/count 异步终端）──
  function makeQuery(table, opts) {
    opts = opts || {};
    const filter = opts.filter || {};
    const sort = opts.sort || null;
    const limitN = opts.limit;
    const skipN = opts.skip;

    return {
      where(f) {
        return makeQuery(table, { filter: Object.assign({}, filter, f), sort, limit: limitN, skip: skipN });
      },
      orderBy(field, dir) {
        return makeQuery(table, {
          filter,
          sort: Object.assign({}, sort || {}, { [field]: dir === 'desc' ? -1 : 1 }),
          limit: limitN,
          skip: skipN,
        });
      },
      limit(n) {
        return makeQuery(table, { filter, sort, limit: n, skip: skipN });
      },
      skip(n) {
        return makeQuery(table, { filter, sort, limit: limitN, skip: n });
      },
      async get() {
        const { sql, params } = buildWhere(filter);
        const result = await executor.query(
          `SELECT data FROM ${table} WHERE ${sql}${sortClause(sort)}${pageClause(limitN, skipN)}`,
          params
        );
        return { data: result.rows.map((row) => row.data) };
      },
      async count() {
        const { sql, params } = buildWhere(filter);
        const result = await executor.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${sql}`, params);
        return result.rows[0].n;
      },
    };
  }

  /** 生成文档 id（模块级 generateId，见文件尾） */

  function collection(name) {
    const table = tableOf(name);
    return {
      doc(id) {
        return {
          async get() {
            const result = await executor.query(`SELECT data FROM ${table} WHERE _id = $1`, [String(id)]);
            return { data: result.rows.map((row) => row.data) };
          },
          async set(data) {
            const doc = Object.assign({}, data, { _id: String(id) });
            await executor.query(
              `INSERT INTO ${table} (_id, data) VALUES ($1, $2::jsonb)
               ON CONFLICT (_id) DO UPDATE SET data = EXCLUDED.data`,
              [String(id), JSON.stringify(doc)]
            );
          },
          async update(data) {
            await executor.query(`UPDATE ${table} SET data = data || $2::jsonb WHERE _id = $1`, [
              String(id),
              JSON.stringify(data),
            ]);
          },
          async remove() {
            await executor.query(`DELETE FROM ${table} WHERE _id = $1`, [String(id)]);
          },
        };
      },

      where(filter) {
        return makeQuery(table).where(filter);
      },
      orderBy(field, dir) {
        return makeQuery(table).orderBy(field, dir);
      },
      skip(offset) {
        return makeQuery(table).skip(offset);
      },

      async add(doc) {
        const id = String(doc._id || generateId());
        await executor.query(
          `INSERT INTO ${table} (_id, data) VALUES ($1, $2::jsonb)
           ON CONFLICT (_id) DO UPDATE SET data = EXCLUDED.data`,
          [id, JSON.stringify(Object.assign({}, doc, { _id: id }))]
        );
        return { id };
      },
    };
  }

  return { collection };
}

/**
 * 事务封装（与 mongo.js runTransaction 语义一致：fn 收到同表面的事务内 collection 工厂，
 * 返回值透传；异常回滚）。session 池化器（5432）下独立连接持锁，真事务语义。
 */
async function runTransaction(fn, options = {}) {
  const dbPool = getPool(options);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const { collection } = makeBackend(client);
    const result = await fn(collection);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) { /* 连接已断时忽略回滚失败 */ }
    throw error;
  } finally {
    client.release();
  }
}

/** 事务冲突判断（对齐 mongo.js isTransactionConflict）：pg 序列化失败 / 死锁 */
function isTransactionConflict(err) {
  if (!err) return false;
  return err.code === '40001' || err.code === '40P01';
}

/** mongo.js 的 command 操作符透传（翻译由 pg-filter 承担） */
const command = {
  lte: (val) => ({ $lte: val }),
  neq: (val) => ({ $ne: val }),
  gte: (val) => ({ $gte: val }),
  in: (val) => ({ $in: val }),
  lt: (val) => ({ $lt: val }),
  gt: (val) => ({ $gt: val }),
  eq: (val) => ({ $eq: val }),
};

module.exports = { getPool, close, ping, collection: (name) => makeBackend(getPool()).collection(name), runTransaction, isTransactionConflict, command, __test: { makeBackend, normalizeUri, generateId } };
