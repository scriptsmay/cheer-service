'use strict';

/**
 * weeklyStory job — ← weekly-story
 * 每周一 05:00，AI 生成周故事卡
 */

const { collection } = require('../db/mongo');
const { generateText } = require('../services/ai');

async function weeklyStory() {
  const result = { week: null, status: 'pending', error: null };

  try {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const mondayOffset = (dayOfWeek + 6) % 7;
    const thisMonday = new Date(now);
    thisMonday.setUTCDate(now.getUTCDate() - mondayOffset);
    thisMonday.setUTCHours(0, 0, 0, 0);
    const lastMonday = new Date(thisMonday);
    lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);

    const weekStr = formatWeek(thisMonday);
    result.week = weekStr;

    const storyCol = await collection('weekly_story');
    const existing = await storyCol.where({ week: weekStr }).get();
    if (existing.data.length > 0) {
      result.status = 'skipped';
      result.error = 'already exists';
      return result;
    }

    const thisWeekSnap = await getSnapshotByDate(formatDate(thisMonday));
    const lastWeekSnap = await getSnapshotByDate(formatDate(lastMonday));

    if (!thisWeekSnap) {
      result.status = 'error';
      result.error = 'no this week snapshot';
      return result;
    }

    const stats = computeDiff(thisWeekSnap.metrics, lastWeekSnap ? lastWeekSnap.metrics : null);
    const latestOverview = await getLatestOverview();

    let heroTopName = '', heroTopWinRate = '';
    if (latestOverview) {
      const rawData = latestOverview.data || {};
      const innerData = rawData.data || rawData;
      const heroStats = innerData.hero_stats || [];
      const heroTop = heroStats.sort((a, b) => (b.battles || 0) - (a.battles || 0)).slice(0, 5);
      if (heroTop.length > 0) { heroTopName = heroTop[0].hero_name; heroTopWinRate = heroTop[0].win_rate; }
    }

    const systemPrompt = `你是一位专业的电竞数据分析师，同时也是KPL选手无言的粉丝。
请基于下面的周环比数据，写一段3-4句的故事体周报，语气生动有情绪感，像粉丝分享一样自然。
要突出数据变化（上升用积极语气，下降用鼓励语气），提到高光英雄。
不要用太正式的词，要口语化，像在跟朋友聊天。
只输出中文正文，不要加标题或列表。`;

    const userPrompt = `【周环比数据 - ${weekStr}】
本周胜率: ${stats.win_rate.current != null ? (stats.win_rate.current * 100).toFixed(1) + '%' : '暂无'}
胜率变化: ${stats.win_rate.diff != null ? (stats.win_rate.diff > 0 ? '+' : '') + (stats.win_rate.diff * 100).toFixed(1) + '%' : '暂无数据对比'}
本周KDA: ${stats.kda_ratio.current != null ? stats.kda_ratio.current.toFixed(2) : '暂无'}
KDA变化: ${stats.kda_ratio.diff != null ? (stats.kda_ratio.diff > 0 ? '+' : '') + stats.kda_ratio.diff.toFixed(2) : '暂无数据对比'}
本周场次: ${stats.battles.current != null ? stats.battles.current : '暂无'}
场次变化: ${stats.battles.diff != null ? (stats.battles.diff > 0 ? '+' : '') + stats.battles.diff : '暂无数据对比'}
高光英雄: ${heroTopName || '暂无'}（胜率 ${heroTopWinRate || '暂无'}）
所属战队: ${latestOverview ? latestOverview.team_name : '暂无'}

请写一段3-4句的故事体周报。`;

    let storyText = '';
    try {
      const res = await generateText({ messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] });
      storyText = res.text;
    } catch (aiErr) {
      console.error('[weeklyStory] AI call failed:', aiErr.message);
      result.status = 'error';
      result.error = 'AI generation failed: ' + aiErr.message;
      return result;
    }

    const doc = { week: weekStr, text: storyText, stats, cover_color: '#00d4ff', created_at: new Date().toISOString() };
    const col = await collection('weekly_story');
    await col.add(doc);

    try {
      const aiCol = await collection('ai_reports');
      await aiCol.add({ module: 'weeklyStory', user_input: `week=${weekStr}`, ai_output: storyText, timestamp: Date.now(), created_at: new Date().toISOString() });
    } catch (_) {}

    result.status = 'success';
  } catch (err) {
    console.error('[weeklyStory] Error:', err.message, err.stack);
    result.status = 'error';
    result.error = err.message;
  }

  return result;
}

function formatDate(date) { return date.toISOString().split('T')[0]; }

function formatWeek(mondayDate) {
  const year = mondayDate.getUTCFullYear();
  const d = new Date(Date.UTC(year, 0, 1));
  const dayNum = Math.floor((mondayDate - d) / 86400000);
  const weekNum = Math.ceil((dayNum + d.getUTCDay() + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

async function getSnapshotByDate(dateStr) {
  try {
    const col = await collection('season_snapshots');
    const res = await col.where({ date: dateStr }).get();
    return res.data.length > 0 ? res.data[0] : null;
  } catch (e) { console.warn(`[weeklyStory] snapshot not found for ${dateStr}:`, e.message); return null; }
}

function computeDiff(current, previous) {
  const stats = {};
  const fields = ['win_rate', 'kda_ratio', 'battles', 'mvp', 'wins', 'loses', 'avg_kills', 'avg_deaths', 'avg_assists'];
  for (const f of fields) {
    stats[f] = { current: current ? current[f] : null, diff: null };
    if (current && previous && current[f] != null && previous[f] != null) {
      stats[f].diff = Math.round((current[f] - previous[f]) * 1000) / 1000;
    }
  }
  return stats;
}

async function getLatestOverview() {
  try {
    const col = await collection('season_summaries');
    const res = await col.orderBy('updated_at', 'desc').limit(1).get();
    return res.data.length > 0 ? res.data[0] : null;
  } catch (e) { return null; }
}

module.exports = { weeklyStory };
