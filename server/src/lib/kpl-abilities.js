'use strict';

/**
 * KPL 选手能力评分（abilities.json）归一化与引用生成
 *
 * 上游产物为「赛季 × 选手」粒度的评分文件，同步时归一化后挂到
 * season_summaries 文档顶层；cheer 生成时再转成可引用数据。
 */

const DIMENSIONS = [
  { key: 'support_ability', label: '支援', displayLabel: '支援能力' },
  { key: 'tankiness', label: '承伤', displayLabel: '承伤能力' },
  { key: 'mid_game', label: '中期', displayLabel: '中期表现' },
  { key: 'initiation', label: '开团', displayLabel: '开团能力' },
  { key: 'early_game', label: '前期', displayLabel: '前期表现' },
  { key: 'map_control', label: '地图控制', displayLabel: '场景控制' },
  { key: 'damage_output', label: '输出', displayLabel: '输出能力' },
  { key: 'teamfight', label: '团战', displayLabel: '团战能力' },
  { key: 'economy', label: '经济', displayLabel: '经济发育' },
  { key: 'late_game', label: '后期', displayLabel: '后期表现' },
  { key: 'durability', label: '生存', displayLabel: '生存能力' },
  { key: 'invasion_ability', label: '入侵', displayLabel: '入侵能力' },
];

const DISPLAY_MAX_RANK = 3;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toRank(value) {
  const num = toFiniteNumber(value);
  if (num === null || num < 1) return null;
  return Math.trunc(num);
}

function matchesPlayer(record, playerName) {
  if (!playerName) return true;
  const name = record.player_name;
  if (typeof name !== 'string' || !name) return false;
  return name === playerName || name.endsWith(`.${playerName}`);
}

function selectRecord(payload, { season, playerName, teamName }) {
  if (!isObject(payload)) return null;
  if (payload.season && payload.season !== season) return null;
  const records = isObject(payload.data) && Array.isArray(payload.data.data) ? payload.data.data : [];
  const seasonRecords = records.filter((record) => isObject(record) && (!record.season || record.season === season));
  const matched = seasonRecords.filter((record) => matchesPlayer(record, playerName));
  if (matched.length === 1) return matched[0];
  if (matched.length > 1 && teamName) {
    const byTeam = matched.filter((record) => record.team_name === teamName);
    if (byTeam.length === 1) return byTeam[0];
  }
  if (!playerName && seasonRecords.length === 1) return seasonRecords[0];
  return null;
}

/**
 * 归一化上游 abilities.json；无法唯一匹配选手/赛季时返回 null（宁可不用，不猜）。
 * @param {object} payload 上游 envelope
 * @param {{season: string, playerName?: string, teamName?: string}} context
 */
function normalizeAbilities(payload, { season, playerName, teamName } = {}) {
  if (!season) return null;
  const record = selectRecord(payload, { season, playerName, teamName });
  if (!record) return null;
  const overallRating = toFiniteNumber(record.overall_rating);
  if (overallRating === null) return null;

  const dimensions = {};
  for (const { key } of DIMENSIONS) {
    const score = toFiniteNumber(record[key]);
    if (score === null) continue;
    dimensions[key] = {
      score,
      overall_rank: toRank(record[`${key}_overall_rank`]),
      position_rank: toRank(record[`${key}_position_rank`]),
    };
  }

  return {
    season,
    generated_at: typeof payload.generated_at === 'string' ? payload.generated_at : '',
    build_id: typeof payload.build_id === 'string' ? payload.build_id : '',
    player_name: typeof record.player_name === 'string' ? record.player_name : '',
    team_name: typeof record.team_name === 'string' ? record.team_name : '',
    position: typeof record.player_position === 'string' ? record.player_position : '',
    overall_rating: overallRating,
    overall_rank: toRank(record.overall_rank),
    position_rank: toRank(record.position_rank),
    total_matches: toFiniteNumber(record.total_matches),
    dimensions,
  };
}

/**
 * 生成可引用数据：综合评分 + 位置分榜第 1 的分项。
 * @param {object} abilities normalizeAbilities 的产物
 * @param {{maxDims?: number}} [options]
 */
function buildAbilityRefs(abilities, { maxDims = 4 } = {}) {
  if (!isObject(abilities)) return [];
  const refs = [];
  const rating = toFiniteNumber(abilities.overall_rating);
  if (rating !== null) {
    const position = typeof abilities.position === 'string' ? abilities.position : '';
    const rankParts = [];
    if (Number.isInteger(abilities.overall_rank)) rankParts.push(`全联盟第${abilities.overall_rank}`);
    if (position && Number.isInteger(abilities.position_rank)) rankParts.push(`${position}第${abilities.position_rank}`);
    const suffix = rankParts.length ? `（${rankParts.join('，')}）` : '';
    refs.push({ label: '联盟综合评分', value: `${rating}${suffix}`, source: 'season_summaries' });
  }

  const topDims = DIMENSIONS
    .map(({ key, label }) => {
      const dim = isObject(abilities.dimensions) ? abilities.dimensions[key] : null;
      if (!isObject(dim) || dim.position_rank !== 1) return null;
      const score = toFiniteNumber(dim.score);
      return score === null ? null : { label, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxDims);
  if (topDims.length) {
    const position = typeof abilities.position === 'string' ? abilities.position : '';
    refs.push({
      label: position ? `${position}分榜第1能力` : '分榜第1能力',
      value: topDims.map((dim) => `${dim.label}${dim.score}`).join('、'),
      source: 'season_summaries',
    });
  }
  return refs;
}

/**
 * 生成前端展示用的紧凑结构：总分/排名 + 位置分榜前 3 名的分项。
 * 与 buildAbilityRefs 分离：refs 继续承载 AI 可引用的完整分数，展示层不参与校验。
 * @param {object} abilities normalizeAbilities 的产物
 */
function buildAbilityDisplay(abilities) {
  if (!isObject(abilities)) return null;
  const rating = toFiniteNumber(abilities.overall_rating);
  if (rating === null) return null;
  const position = typeof abilities.position === 'string' ? abilities.position : '';
  const fields = DIMENSIONS
    .map(({ key, displayLabel }) => {
      const dim = isObject(abilities.dimensions) ? abilities.dimensions[key] : null;
      if (!isObject(dim)) return null;
      const score = toFiniteNumber(dim.score);
      const rank = toRank(dim.position_rank);
      if (score === null || rank === null || rank > DISPLAY_MAX_RANK) return null;
      return { key, label: displayLabel, score, rank };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || b.score - a.score);

  return {
    score: rating,
    overall_rank: Number.isInteger(abilities.overall_rank) ? abilities.overall_rank : null,
    position: position || null,
    position_rank: Number.isInteger(abilities.position_rank) ? abilities.position_rank : null,
    fields,
  };
}

module.exports = { DIMENSIONS, normalizeAbilities, buildAbilityRefs, buildAbilityDisplay };
