'use strict';

/**
 * Supabase 建表脚本（v1.3.0 D6）— 幂等，可重复执行
 *
 * 用法: POSTGRES_URI=postgresql://... node scripts/pg-create-schema.js
 * 建独立 schema（默认 cheer，PG_SCHEMA 可覆盖）+ 12 张集合表；
 * weekly_story 不建（2026-09-21 拍板清理，不迁移）。
 * 表结构：(_id text PRIMARY KEY, data jsonb)——见 server/src/db/postgres.js。
 */

const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
const config = require(path.join(__dirname, '../server/src/config/env'));
const { getPool } = require(path.join(__dirname, '../server/src/db/postgres'));

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

async function main() {
  if (!config.pgUri) throw new Error('POSTGRES_URI 未配置');
  const schema = config.pgSchema;
  const pool = getPool();

  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  console.log(`schema ready: ${schema}`);

  for (const name of COLLECTIONS) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "${schema}"."${name}" (_id text PRIMARY KEY, data jsonb NOT NULL)`
    );
    console.log(`table ready: ${schema}.${name}`);
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
    [schema]
  );
  console.log(`tables in schema ${schema}: ${rows[0].n}`);
  await pool.end();
  console.log('SCHEMA_DONE');
}

main().catch((error) => {
  console.error('SCHEMA_FAILED:', error.message);
  process.exit(1);
});
