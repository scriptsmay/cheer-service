'use strict';

/**
 * MongoDB 连接 + TCB SDK 兼容封装层
 *
 * 将 TCB 文档数据库的链式 API 封装为 MongoDB 原生操作，
 * 业务代码只需将 `db.collection('xxx')` 替换为 `collection('xxx')` 即可。
 */

const { MongoClient } = require('mongodb');
const config = require('../config/env');

let client;
let dbInstance;

async function getDb() {
  if (!client) {
    client = new MongoClient(config.mongoUri);
    await client.connect();
    dbInstance = client.db(config.mongoDbName);
    console.log('[mongo] connected to', config.mongoUri.split('@')[1] || config.mongoUri);
  }
  return dbInstance;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    dbInstance = null;
  }
}

/**
 * 封装 collection，提供与 TCB SDK 类似的链式 API
 * TCB 特有差异点已在封装层统一处理
 */
async function collection(name) {
  const db = await getDb();
  const coll = db.collection(name);

  // ── 链式查询构造器（兼容 TCB SDK 链式语法）──
  // 支持 where().orderBy().limit().skip().get() 任意顺序组合
  // where/orderBy/limit/skip 为链式（同步），get/count 为终端（异步）
  function makeQuery(opts) {
    opts = opts || {};
    const filter = opts.filter || {};
    const sort = opts.sort || null;
    const limitN = opts.limit;
    const skipN = opts.skip;

    return {
      where(f) {
        // 合并条件（后者覆盖同名字段），与 TCB 多次 where 行为一致
        return makeQuery({ filter: Object.assign({}, filter, f), sort, limit: limitN, skip: skipN });
      },
      orderBy(field, dir) {
        const sortDir = dir === 'desc' ? -1 : 1;
        return makeQuery({ filter, sort: Object.assign({}, sort || {}, { [field]: sortDir }), limit: limitN, skip: skipN });
      },
      limit(n) {
        return makeQuery({ filter, sort, limit: n, skip: skipN });
      },
      skip(n) {
        return makeQuery({ filter, sort, limit: limitN, skip: n });
      },
      async get() {
        let cursor = coll.find(filter);
        if (sort) cursor = cursor.sort(sort);
        if (skipN) cursor = cursor.skip(skipN);
        if (limitN != null) cursor = cursor.limit(limitN);
        return { data: await cursor.toArray() };
      },
      async count() {
        return await coll.countDocuments(filter);
      },
    };
  }

  return {
    // ── 单文档操作 ──
    doc(id) {
      return {
        async get() {
          const doc = await coll.findOne({ _id: id });
          return { data: doc ? [doc] : [] };
        },
        async set(data) {
          await coll.updateOne(
            { _id: id },
            { $set: Object.assign({}, data, { _id: id }) },
            { upsert: true }
          );
        },
        async update(data) {
          await coll.updateOne({ _id: id }, { $set: data });
        },
        async remove() {
          await coll.deleteOne({ _id: id });
        },
      };
    },

    // ── 链式查询入口 ──
    where(filter) { return makeQuery().where(filter); },
    orderBy(field, dir) { return makeQuery().orderBy(field, dir); },
    skip(offset) { return makeQuery().skip(offset); },

    // ── 新增 ──
    async add(doc) {
      // TCB add() 不指定 _id 时自动生成字符串 ID；MongoDB 用 ObjectId
      // 为兼容性，如果 doc 没有 _id 则保留 MongoDB 默认 ObjectId
      const result = await coll.insertOne(doc);
      return { id: result.insertedId };
    },
  };
}

/**
 * 事务封装（替代 TCB db.runTransaction）
 * MongoDB 需要副本集才能用事务
 */
async function runTransaction(fn) {
  await getDb();
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      // 事务内的 collection 需要传入 session
      const db = await getDb();
      const transactionCollection = (name) => {
        const coll = db.collection(name);
        // 事务内链式查询构造器（与主 collection 行为一致，附带 session）
        function makeQuery(opts) {
          opts = opts || {};
          const filter = opts.filter || {};
          const sort = opts.sort || null;
          const limitN = opts.limit;
          const skipN = opts.skip;
          return {
            where(f) { return makeQuery({ filter: Object.assign({}, filter, f), sort, limit: limitN, skip: skipN }); },
            orderBy(field, dir) { return makeQuery({ filter, sort: Object.assign({}, sort || {}, { [field]: dir === 'desc' ? -1 : 1 }), limit: limitN, skip: skipN }); },
            limit(n) { return makeQuery({ filter, sort, limit: n, skip: skipN }); },
            skip(n) { return makeQuery({ filter, sort, limit: limitN, skip: n }); },
            async get() {
              let cursor = coll.find(filter, { session });
              if (sort) cursor = cursor.sort(sort);
              if (skipN) cursor = cursor.skip(skipN);
              if (limitN != null) cursor = cursor.limit(limitN);
              return { data: await cursor.toArray() };
            },
            async count() { return await coll.countDocuments(filter, { session }); },
          };
        }
        return {
          doc(id) {
            return {
              async get() {
                const doc = await coll.findOne({ _id: id }, { session });
                return { data: doc ? [doc] : [] };
              },
              async set(data) {
                await coll.updateOne(
                  { _id: id },
                  { $set: { ...data, _id: id } },
                  { upsert: true, session }
                );
              },
              async update(data) {
                await coll.updateOne({ _id: id }, { $set: data }, { session });
              },
              async remove() {
                await coll.deleteOne({ _id: id }, { session });
              },
            };
          },
          where(filter) { return makeQuery().where(filter); },
          orderBy(field, dir) { return makeQuery().orderBy(field, dir); },
          skip(offset) { return makeQuery().skip(offset); },
          async add(doc) {
            const result = await coll.insertOne(doc, { session });
            return { id: result.insertedId };
          },
        };
      };
      return await fn(transactionCollection);
    });
  } finally {
    await session.endSession();
  }
}

/**
 * 事务冲突判断（替代 TCB isTransactionConflict）
 */
function isTransactionConflict(err) {
  if (!err) return false;
  // MongoDB WriteConflict / transient transaction error
  const code = err.code || err.errorCode || '';
  return code === 112 || code === 244 || err.message?.includes('WriteConflict');
}

/**
 * command 操作符（替代 TCB db.command）
 * TCB 的 command 是查询操作符，MongoDB 原生用 $op 形式
 */
const command = {
  lte: (val) => ({ $lte: val }),
  neq: (val) => ({ $ne: val }),
  gte: (val) => ({ $gte: val }),
  in: (val) => ({ $in: val }),
  lt: (val) => ({ $lt: val }),
  gt: (val) => ({ $gt: val }),
  eq: (val) => ({ $eq: val }),
};

module.exports = { getDb, close, collection, runTransaction, isTransactionConflict, command };
