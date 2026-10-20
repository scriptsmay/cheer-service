'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAbilities, buildAbilityRefs, DIMENSIONS } = require('../src/lib/kpl-abilities');

// 2026-10-20 上游 abilities.json 的真实字段形状
const RECORD = {
  player_name: 'KSG.无言',
  team_name: 'KSG',
  player_position: '对抗路',
  season: 'KPL2026S3',
  overall_rating: 93.7,
  overall_rank: 1.0,
  position_rank: 1.0,
  previous_overall_rating: 96.0,
  previous_overall_rank: 1.0,
  total_matches: 20.0,
  support_ability: 97, support_ability_overall_rank: 11.0, support_ability_position_rank: 1.0,
  tankiness: 97, tankiness_overall_rank: 13.0, tankiness_position_rank: 5.0,
  mid_game: 95, mid_game_overall_rank: 7.0, mid_game_position_rank: 4.0,
  initiation: 94, initiation_overall_rank: 13.0, initiation_position_rank: 1.0,
  early_game: 88, early_game_overall_rank: 8.0, early_game_position_rank: 1.0,
  map_control: 90, map_control_overall_rank: 3.0, map_control_position_rank: 1.0,
  damage_output: 93, damage_output_overall_rank: 21.0, damage_output_position_rank: 3.0,
  teamfight: 90, teamfight_overall_rank: 2.0, teamfight_position_rank: 2.0,
  economy: 86, economy_overall_rank: 24.0, economy_position_rank: 3.0,
  late_game: 93, late_game_overall_rank: 6.0, late_game_position_rank: 2.0,
  durability: 72, durability_overall_rank: 8.0, durability_position_rank: 2.0,
  invasion_ability: 86, invasion_ability_overall_rank: 6.0, invasion_ability_position_rank: 2.0,
};

const PAYLOAD = {
  schema_version: 1,
  season: 'KPL2026S3',
  generated_at: '2026-10-20T03:01:06+08:00',
  build_id: '20261020T030106+0800',
  data: { code: 200, data: [RECORD] },
};

const CONTEXT = { season: 'KPL2026S3', playerName: '无言', teamName: 'KSG' };

describe('normalizeAbilities', () => {
  test('选中选手并归一化评分、排名与 12 个维度', () => {
    const abilities = normalizeAbilities(PAYLOAD, CONTEXT);
    assert.ok(abilities);
    assert.strictEqual(abilities.season, 'KPL2026S3');
    assert.strictEqual(abilities.player_name, 'KSG.无言');
    assert.strictEqual(abilities.position, '对抗路');
    assert.strictEqual(abilities.overall_rating, 93.7);
    assert.strictEqual(abilities.overall_rank, 1);
    assert.strictEqual(abilities.position_rank, 1);
    assert.strictEqual(abilities.total_matches, 20);
    assert.strictEqual(abilities.generated_at, '2026-10-20T03:01:06+08:00');
    assert.strictEqual(Object.keys(abilities.dimensions).length, DIMENSIONS.length);
    assert.deepStrictEqual(abilities.dimensions.support_ability, {
      score: 97, overall_rank: 11, position_rank: 1,
    });
  });

  test('同昵称多条记录时按战队收窄', () => {
    const payload = {
      ...PAYLOAD,
      data: { data: [RECORD, { ...RECORD, player_name: '狼队.无言', team_name: '狼队', overall_rating: 80 }] },
    };
    const abilities = normalizeAbilities(payload, CONTEXT);
    assert.ok(abilities);
    assert.strictEqual(abilities.team_name, 'KSG');
    assert.strictEqual(abilities.overall_rating, 93.7);
  });

  test('无匹配选手 / 歧义 / 赛季不符均返回 null', () => {
    assert.strictEqual(normalizeAbilities(PAYLOAD, { season: 'KPL2026S3', playerName: '小胖' }), null);
    assert.strictEqual(normalizeAbilities({ ...PAYLOAD, season: 'KPL2026S2' }, CONTEXT), null);
    const ambiguous = {
      ...PAYLOAD,
      data: { data: [RECORD, { ...RECORD, player_name: '狼队.无言' }] },
    };
    assert.strictEqual(
      normalizeAbilities(ambiguous, { season: 'KPL2026S3', playerName: '无言' }),
      null,
      '无法唯一确定选手时宁可不用',
    );
  });

  test('缺 overall_rating 或数据结构非法时返回 null', () => {
    const noRating = { ...RECORD };
    delete noRating.overall_rating;
    assert.strictEqual(normalizeAbilities({ ...PAYLOAD, data: { data: [noRating] } }, CONTEXT), null);
    assert.strictEqual(normalizeAbilities({}, CONTEXT), null);
    assert.strictEqual(normalizeAbilities(null, CONTEXT), null);
  });
});

describe('buildAbilityRefs', () => {
  test('产出综合评分与对抗路分榜第1分项', () => {
    const refs = buildAbilityRefs(normalizeAbilities(PAYLOAD, CONTEXT));
    assert.deepStrictEqual(refs, [
      {
        label: '联盟综合评分',
        value: '93.7（全联盟第1，对抗路第1）',
        source: 'season_summaries',
      },
      {
        label: '对抗路分榜第1能力',
        value: '支援97、开团94、地图控制90、前期88',
        source: 'season_summaries',
      },
    ]);
  });

  test('不引用非分榜第 1 的维度，也不带上期评分', () => {
    const refs = buildAbilityRefs(normalizeAbilities(PAYLOAD, CONTEXT));
    const text = JSON.stringify(refs);
    assert.ok(!text.includes('承伤'), '承伤第5不应被引用');
    assert.ok(!text.includes('中期'), '中期第4不应被引用');
    assert.ok(!text.includes('96'), '上期评分 96 不应暴露');
  });

  test('无分榜第 1 维度时只产出综合评分', () => {
    const abilities = normalizeAbilities(PAYLOAD, CONTEXT);
    for (const dim of Object.values(abilities.dimensions)) dim.position_rank = 2;
    const refs = buildAbilityRefs(abilities);
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].label, '联盟综合评分');
  });

  test('maxDims 限制分项数量', () => {
    const refs = buildAbilityRefs(normalizeAbilities(PAYLOAD, CONTEXT), { maxDims: 2 });
    assert.strictEqual(refs[1].value, '支援97、开团94');
  });
});
