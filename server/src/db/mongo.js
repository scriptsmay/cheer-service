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
  return {
    // ── 单文档操作 ──
    doc(id) {
      return {
        async get() {
          const doc = await db.collection(name).findOne({ _id: id });
          return { data: doc ? [doc] : [] };
        },
        async set(data) {
          await db.collection(name).updateOne(
            { _id: id },
            { $set: { ...data, _id: id } },
            { upsert: true }
          );
        },
        async update(data) {
          await db.collection(name).updateOne({ _id: id }, { $set: data });
        },
        async remove() {
          await db.collection(name).deleteOne({ _id: id });
        },
      };
    },

    // ── 条件查询 ──
    where(filter) {
      return {
        async get() {
          const docs = await db.collection(name).find(filter).toArray();
          return { data: docs };
        },
        async limit(n) {
          const docs = await db.collection(name).find(filter).limit(n).toArray();
          return { data: docs };
        },
        async count() {
          return await db.collection(name).countDocuments(filter);
        },
      };
    },

    // ── 排序+限制 ──
    orderBy(field, dir) {
      const sortDir = dir === 'desc' ? -1 : 1;
      return {
        limit(n) {
          return {
            async get() {
              const docs = await db.collection(name)
                .find({})
                .sort({ [field]: sortDir })
                .limit(n)
                .toArray();
              return { data: docs };
            },
          };
        },
        async get() {
          const docs = await db.collection(name)
            .find({})
            .sort({ [field]: sortDir })
            .toArray();
          return { data: docs };
        },
      };
    },

    // ── 新增 ──
    async add(doc) {
      // TCB add() 不指定 _id 时自动生成字符串 ID；MongoDB 用 ObjectId
      // 为兼容性，如果 doc 没有 _id 则保留 MongoDB 默认 ObjectId
      const result = await db.collection(name).insertOne(doc);
      return { id: result.insertedId };
    },

    // ── 分页 ──
    skip(offset) {
      return {
        limit(n) {
          return {
            async get() {
              const docs = await db.collection(name)
                .find({})
                .skip(offset)
                .limit(n)
                .toArray();
              return { data: docs };
            },
          };
        },
      };
    },
  };
}

/**
 * 事务封装（替代 TCB db.runTransaction）
 * MongoDB 需要副本集才能用事务
 */
async function runTransaction(fn) {
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      // 事务内的 collection 需要传入 session
      const db = await getDb();
      const transactionCollection = (name) => {
        const coll = db.collection(name);
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
          where(filter) {
            return {
              async get() {
                const docs = await coll.find(filter, { session }).toArray();
                return { data: docs };
              },
              async limit(n) {
                const docs = await coll.find(filter, { session }).limit(n).toArray();
                return { data: docs };
              },
            };
          },
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
