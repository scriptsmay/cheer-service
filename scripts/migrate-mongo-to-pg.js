'use strict';

/**
 * Mongo → Postgres 数据迁移脚本（v1.3.0 D7）
 *
 * 设计运行位置：txyun wuyan-api 容器内（自带 MONGO_URI 与 POSTGRES_URI 环境）
 *   docker exec wuyan-api node scripts/migrate-mongo-to-pg.js
 * 也可在本机连远端执行：POSTGRES_URI=... MONGO_URI=... node scripts/migrate-mongo-to-pg.js
 *
 * 流程：逐集合 Mongo 全量导出 → ObjectId/嵌套 id 转 hex 字符串 → 逐条 upsert 进 PG
 *       → 双端计数核对 + 每集合抽样 JSON 比对 → 输出对账表。
 * weekly_story 不迁移（2026-09-21 拍板清理）。导入用 upsert，脚本可安全重跑。
 */

const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
const mongo = require(path.join(__dirname, '../server/src/db/mongo')); // 固定走 Mongo 导出，与 DB_DRIVER 无关
const pg = require(path.join(__dirname, '../server/src/db/postgres'));
const config = require(path.join(__dirname, '../server/src/config/env'));

const COLLECTIONS = [
  'season_summaries',
  'live_streams',
  'match_schedules',
  'ai_reports',
  'ask_cache',
  'checkins',
  'checkin_users',
  'checkin_daily_stats',
  'usage_limits',
  'app_config',
  'season_snapshots',
  'sync_snapshots',
];

/** ObjectId（含嵌套字段）→ hex 字符串，保证可 JSON 序列化且与 PG 存储形态一致 */
function normalizeDoc(doc) {
  const clone = JSON.parse(JSON.stringify(doc, (key, value) => {
    if (value && typeof value === 'object' && value._bsontype === 'ObjectId') return value.toString();
    return value;
  }));
  clone._id = String(clone._id);
  return clone;
}

async function migrateCollection(name) {
  const mongoCol = await mongo.collection(name);
  const { data } = await mongoCol.where({}).get();
  const pgCol = pg.collection(name);
  let imported = 0;
  for (const raw of data) {
    const doc = normalizeDoc(raw);
    await pgCol.doc(doc._id).set(doc);
    imported += 1;
  }

  const pgCount = await pgCol.where({}).count();
  const sampleOk = await compareSamples(name, data.slice(0, 3), pgCol);
  return { name, mongoCount: data.length, pgCount, imported, sampleOk };
}

async function compareSamples(name, mongoSamples, pgCol) {
  for (const raw of mongoSamples) {
    const id = String(raw._id);
    const expected = JSON.parse(JSON.stringify(normalizeDoc(raw)));
    const { data } = await pgCol.doc(id).get();
    if (!data.length) return { id, ok: false, reason: 'missing' };
    if (JSON.stringify(data[0]) !== JSON.stringify(expected)) return { id, ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

async function main() {
  if (!config.pgUri) throw new Error('POSTGRES_URI 未配置');
  console.log(`=== Mongo → Postgres 迁移（schema: ${config.pgSchema}，排除 weekly_story） ===`);

  const report = [];
  for (const name of COLLECTIONS) {
    const row = await migrateCollection(name);
    report.push(row);
    console.log(
      `${row.name}: mongo=${row.mongoCount} pg=${row.pgCount} imported=${row.imported} sample=${row.sampleOk.ok ? 'OK' : `FAIL(${row.sampleOk.reason})`}`
    );
  }

  const mismatches = report.filter((r) => r.mongoCount !== r.pgCount || r.imported !== r.mongoCount || !r.sampleOk.ok);
  console.log('=== 对账 ===');
  if (mismatches.length) {
    console.error('MIGRATION_VERIFY_FAILED:', mismatches.map((r) => r.name).join(', '));
    process.exitCode = 1;
  } else {
    console.log('MIGRATION_VERIFY_OK: 全部 12 集合计数一致、抽样一致');
  }
  await mongo.close();
  await pg.close();
}

main().catch((error) => {
  console.error('MIGRATION_FAILED:', error.message);
  process.exit(1);
});
