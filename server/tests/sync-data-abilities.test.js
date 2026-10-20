'use strict';

process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');

// syncData 在加载期解构 collection，必须先打桩再 require
const stub = { docs: {} };
db.collection = async (name) => {
  stub.docs[name] = stub.docs[name] || [];
  return {
    where: () => ({ get: async () => ({ data: [] }) }),
    add: async (doc) => { stub.docs[name].push(doc); },
    doc: () => ({ update: async () => {}, remove: async () => {} }),
  };
};

const kplSource = require('../src/lib/kpl-source');
const { syncData } = require('../src/jobs/syncData');

const SEASON = 'KPL2026S3';

const OVERVIEW = {
  data: {
    player_info: { latest_nickname: '无言', latest_team: 'KSG' },
    career_summary: { last_season_id: SEASON, win_rate: 0.55, kda_ratio: 4.1, total_matches: 20, mvp_count: 5 },
    season_stats: [],
    hero_stats: [],
  },
};

const ABILITIES = {
  schema_version: 1,
  season: SEASON,
  generated_at: '2026-10-20T03:01:06+08:00',
  build_id: '20261020T030106+0800',
  data: {
    data: [{
      player_name: 'KSG.无言',
      team_name: 'KSG',
      player_position: '对抗路',
      season: SEASON,
      overall_rating: 93.7,
      overall_rank: 1,
      position_rank: 1,
      total_matches: 20,
      support_ability: 97, support_ability_overall_rank: 11, support_ability_position_rank: 1,
      initiation: 94, initiation_overall_rank: 13, initiation_position_rank: 1,
    }],
  },
};

function stubSource(files) {
  kplSource.readKplJson = async (relPath) => files[relPath] ?? null;
  kplSource.describeSource = () => 'stub:test';
}

function summaryDoc() {
  assert.strictEqual(stub.docs.season_summaries.length, 1);
  return stub.docs.season_summaries[0];
}

describe('syncData — abilities 并入 season_summaries', () => {
  beforeEach(() => {
    stub.docs = {};
    stubSource({
      'data/latest/current-season.json': { current: SEASON },
      [`data/derived/${SEASON}/overview.json`]: OVERVIEW,
      [`data/derived/${SEASON}/abilities.json`]: ABILITIES,
    });
  });

  test('abilities 正常时写入顶层归一化字段，data 保持原样', async () => {
    const results = await syncData();
    assert.deepStrictEqual(results.errors, []);
    const doc = summaryDoc();
    assert.strictEqual(doc.data, OVERVIEW);
    assert.strictEqual(doc.abilities.season, SEASON);
    assert.strictEqual(doc.abilities.player_name, 'KSG.无言');
    assert.strictEqual(doc.abilities.position, '对抗路');
    assert.strictEqual(doc.abilities.overall_rating, 93.7);
    assert.strictEqual(doc.abilities.overall_rank, 1);
    assert.strictEqual(doc.abilities.dimensions.support_ability.score, 97);
    assert.ok(results.synced.includes('season_summaries'));
  });

  test('abilities 缺失时不写 abilities 字段（合并写保留上次数值）', async () => {
    stubSource({
      'data/latest/current-season.json': { current: SEASON },
      [`data/derived/${SEASON}/overview.json`]: OVERVIEW,
    });
    const results = await syncData();
    assert.deepStrictEqual(results.errors, []);
    const doc = summaryDoc();
    assert.ok(!('abilities' in doc), '缺失时应省略字段，不能写 null');
    assert.ok(results.skipped.includes('abilities.json'));
  });

  test('abilities 选手不匹配时跳过且同步不失败', async () => {
    stubSource({
      'data/latest/current-season.json': { current: SEASON },
      [`data/derived/${SEASON}/overview.json`]: OVERVIEW,
      [`data/derived/${SEASON}/abilities.json`]: {
        ...ABILITIES,
        data: { data: [{ ...ABILITIES.data.data[0], player_name: '狼队.小胖' }] },
      },
    });
    const results = await syncData();
    assert.deepStrictEqual(results.errors, []);
    assert.ok(!('abilities' in summaryDoc()));
    assert.ok(results.synced.includes('season_summaries'));
  });
});
