'use strict';

/**
 * MongoDB 索引创建脚本
 * 迁移后需在 MongoDB 上重建索引以保证查询性能
 */

const { MongoClient } = require('mongodb');

const INDEXES = {
  season_summaries: [
    { key: { season: 1 }, name: 'idx_season' },
    { key: { updated_at: -1 }, name: 'idx_updated_at' },
  ],
  live_streams: [
    { key: { year: 1, month: 1 }, name: 'idx_year_month' },
    { key: { stream_date: -1 }, name: 'idx_stream_date' },
    { key: { type: 1, month_key: 1 }, name: 'idx_summary_month' },
    { key: { stream_date: 1, external_id: 1 }, name: 'idx_date_external_id' },
  ],
  match_schedules: [
    { key: { season_id: 1 }, name: 'idx_season_id' },
    { key: { updated_at: -1 }, name: 'idx_updated_at' },
  ],
  weekly_story: [
    { key: { week: 1 }, name: 'idx_week' },
    { key: { created_at: -1 }, name: 'idx_created_at' },
  ],
  ai_reports: [
    { key: { expires_at: 1, status: 1 }, name: 'idx_expires_status' },
    { key: { module: 1, subject_id: 1 }, name: 'idx_module_subject' },
  ],
  ask_cache: [
    { key: { expires_at: 1 }, name: 'idx_expires_at' },
  ],
  checkins: [
    { key: { subject_id: 1, date: 1 }, name: 'idx_subject_date' },
  ],
  checkin_users: [
    { key: { subject_id: 1 }, name: 'idx_subject_id', unique: true },
  ],
  checkin_daily_stats: [
    { key: { date: 1 }, name: 'idx_date' },
  ],
  usage_limits: [
    { key: { module: 1, dimension: 1, date: 1 }, name: 'idx_module_dimension_date' },
  ],
  season_snapshots: [
    { key: { date: 1, season_id: 1 }, name: 'idx_date_season' },
    { key: { created_at: -1 }, name: 'idx_created_at' },
  ],
  sync_snapshots: [
    { key: { type: 1, updated_at: -1 }, name: 'idx_type_updated' },
  ],
};

async function main() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://wuyan:changeme_strong_password@localhost:27017/wuyan?authSource=admin&replicaSet=rs0';

  console.log('Creating MongoDB indexes...');
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db('wuyan');

  for (const [collectionName, indexes] of Object.entries(INDEXES)) {
    const col = db.collection(collectionName);
    for (const idx of indexes) {
      try {
        await col.createIndex(idx.key, { name: idx.name, unique: idx.unique || false });
        console.log(`  ✓ ${collectionName}.${idx.name}`);
      } catch (e) {
        console.warn(`  ✗ ${collectionName}.${idx.name}: ${e.message}`);
      }
    }
  }

  await client.close();
  console.log('Index creation complete.');
}

main().catch((err) => {
  console.error('Index creation error:', err.message);
  process.exit(1);
});
