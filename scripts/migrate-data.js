'use strict';

/**
 * 数据迁移脚本 — 从 TCB 文档数据库导出数据到本地 JSON 文件
 * 用法: node scripts/migrate-data.js
 *
 * 步骤：
 * 1. 使用 TCB CLI 或 @cloudbase/node-sdk 逐个导出集合数据
 * 2. 保存到 data/export/ 目录
 * 3. 提供导入 MongoDB 的指南
 *
 * ⚠️ 注意：此脚本需要 TCB 环境配置才能运行
 * 请确保 .env 文件包含 TCB_ENV 和腾讯云密钥
 */

const path = require('path');
const fs = require('fs');

// 11 个必须迁移的集合 + 2 个辅助集合
const COLLECTIONS = [
  'season_summaries',
  'live_streams',
  'match_schedules',
  'weekly_story',
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

const EXPORT_DIR = path.resolve(__dirname, '../data/export');

async function main() {
  console.log('=== TCB → NAS Data Migration ===');
  console.log('');

  // 确保 export 目录存在
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }

  console.log('Target collections to export:');
  for (const col of COLLECTIONS) {
    console.log(`  - ${col}`);
  }
  console.log('');
  console.log('Export directory:', EXPORT_DIR);
  console.log('');

  // ── 方法 A：使用 TCB CLI 批量导出 ──
  console.log('=== Method A: TCB CLI Export ===');
  console.log('');
  console.log('Install TCB CLI:');
  console.log('  npm install -g @cloudbase/cli');
  console.log('');
  console.log('Login:');
  console.log('  tcb login');
  console.log('');
  console.log('Export each collection:');
  console.log('');

  const envId = process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062';
  for (const col of COLLECTIONS) {
    const filePath = path.join(EXPORT_DIR, `${col}.json`);
    console.log(`  tcb db export --envId ${envId} --collection ${col} --file "${filePath}"`);
  }

  console.log('');
  console.log('=== Method B: Script-based Export (using @cloudbase/node-sdk) ===');
  console.log('');
  console.log('If TCB CLI fails, you can use the @cloudbase/node-sdk to pull data programmatically.');
  console.log('A sample script would:');
  console.log('  1. Initialize cloudbase SDK with your ENV_ID');
  console.log('  2. For each collection, call db.collection(name).get() with pagination');
  console.log('  3. Write results to JSON files in data/export/');
  console.log('');
  console.log('Sample code:');
  console.log(`
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: '${envId}' });
  const db = app.database();
  for (const col of COLLECTIONS) {
    const result = await db.collection(col).limit(1000).get();
    fs.writeFileSync(path.join(EXPORT_DIR, '${col}.json'), JSON.stringify(result.data, null, 2));
    console.log('Exported ${col}: ' + result.data.length + ' records');
  }
  `);

  // ── 导入到本地 MongoDB ──
  console.log('=== Import to Local MongoDB ===');
  console.log('');
  console.log('After exporting, import each collection into your local MongoDB:');
  console.log('');

  const mongoUri = process.env.MONGO_URI || 'mongodb://wuyan:changeme_strong_password@localhost:27017/wuyan?authSource=admin&replicaSet=rs0';
  for (const col of COLLECTIONS) {
    const filePath = path.join(EXPORT_DIR, `${col}.json`);
    console.log(`  mongoimport --uri "${mongoUri}" --collection ${col} --file "${filePath}" --jsonArray`);
  }

  console.log('');
  console.log('=== Post-migration Steps ===');
  console.log('');
  console.log('1. Initialize MongoDB replica set (required for transactions):');
  console.log('   docker exec -it wuyan-mongo mongosh --eval "rs.initiate({ _id: \'rs0\', members: [{ _id: 0, host: \'localhost:27017\' }] })"');
  console.log('');
  console.log('2. Create indexes for performance:');
  console.log('   See scripts/create-indexes.js');
  console.log('');
  console.log('3. Verify data integrity:');
  console.log('   Compare record counts in TCB vs local MongoDB for each collection');
  console.log('');

  // ── 生成导入命令脚本 ──
  const importScript = [];
  importScript.push('#!/bin/bash');
  importScript.push('# MongoDB data import script');
  importScript.push('# Run this after TCB CLI export completes');
  importScript.push('');
  for (const col of COLLECTIONS) {
    const filePath = path.join(EXPORT_DIR, `${col}.json`);
    importScript.push(`echo "Importing ${col}..."`);
    importScript.push(`mongoimport --uri "${mongoUri}" --collection ${col} --file "${filePath}" --jsonArray || echo "WARN: ${col} import failed"`);
  }
  importScript.push('');
  importScript.push('echo "All collections imported. Verify counts:"');
  importScript.push('mongosh "${mongoUri}" --eval "db.getCollectionNames().forEach(c => print(c + ': ' + db[c].countDocuments()))"');

  fs.writeFileSync(path.join(EXPORT_DIR, 'import.sh'), importScript.join('\n'));
  console.log('Import script saved to: data/export/import.sh');
  console.log('');
  console.log('=== Migration preparation complete ===');
}

main().catch((err) => {
  console.error('Migration script error:', err.message);
  process.exit(1);
});
