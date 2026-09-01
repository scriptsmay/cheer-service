'use strict';

/**
 * date-context.js — 应援文案「时间上下文」模块
 *
 * 解决缺赛期文案每天雷同问题的时间锚点层：
 *  - 节气：当天，或距上一个/下一个节气 ≤ 3 天 → 注入
 *  - 节日（农历 + 公历）：当天，或未来 7 天内 → 注入
 *  - 赛事事件（来自 cheer_events 事件表）：命中窗口 [date - leadDays, date]，
 *    三档强度（preview 预热 / countdown 倒数 / eve 临场 / today 当天）
 *
 * 策略：命中才注入。无任何锚点返回 null，prompt 完全不出现时间段，
 * 避免"报菜名式"生硬句子。
 *
 * 本模块为纯函数（不依赖 DB / 网络），可直接单元测试。
 */

const { Solar } = require('lunar-javascript');

const DAY_MS = 24 * 60 * 60 * 1000;
const JIE_QI_NEAR_DAYS = 3;
const FESTIVAL_LOOKAHEAD_DAYS = 7;
const DEFAULT_LEAD_DAYS = 30;
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
// 预热期里程碑日（milestone:true 强注入标记）：T-lead / T-20 / T-15 / T-10；
// 其余预热日轻提命中（milestone:false），避免回到「事件连续多日完全不可见」的老问题
const MILESTONE_DAYS = [20, 15, 10];

// 公历节日白名单：lunar-javascript 的 solar.getFestivals() 会返回大量冷门公历日
//（世界住房日、全民国防教育日等），不适合注入应援文案，只保留主流节日。
const SOLAR_FESTIVAL_WHITELIST = new Set([
  '元旦', '情人节', '妇女节', '植树节', '劳动节', '儿童节',
  '建党节', '建军节', '教师节', '国庆节', '圣诞节',
]);

// 倒数句式模板库（≥5 种轮换，防连续两天同一句式形成新的公式化）
const EVENT_TEMPLATES = {
  preview: [
    '还有 {n} 天，{title}就要来了',
    '距离 {date} 的{title}，还有 {n} 天',
    '{title}进入预告期，还有 {n} 天',
    '{n} 天后，亚运赛场见',
  ],
  countdown: [
    '倒计时 {n} 天，{title}越来越近了',
    '还有 {n} 天，就是{title}',
    '{n} 天后，{title}见',
    '{title}倒数第 {n} 天',
    '距离{title}还有 {n} 天',
  ],
  eve: [
    '明天（{date}）就是{title}',
    '明天{title}，一起为选手加油',
  ],
  today: [
    '今天（{date}）就是{title}',
    '就是今天！{title}',
  ],
};

// ── 日期工具（均按 Asia/Shanghai 日期字符串 'YYYY-MM-DD' 处理，规避时区）──

function parseDateStr(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dateStr === 'string' ? dateStr : '');
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/** 两个日期（'YYYY-MM-DD' 或 {y,mo,d}）之差，返回 b - a 的天数 */
function diffDays(a, b) {
  const pa = typeof a === 'string' ? parseDateStr(a) : a;
  const pb = typeof b === 'string' ? parseDateStr(b) : b;
  if (!pa || !pb) return Number.NaN;
  return Math.round((Date.UTC(pb.y, pb.mo - 1, pb.d) - Date.UTC(pa.y, pa.mo - 1, pa.d)) / DAY_MS);
}

function toSolar(dateStr) {
  const p = parseDateStr(dateStr);
  if (!p) return null;
  return Solar.fromYmd(p.y, p.mo, p.d);
}

// ── 事件档位计算（纯函数）──

/**
 * 计算事件在 today 的档位。
 * @param {{date:string, leadDays?:number}} event 事件（cheer_events 文档）
 * @param {string} todayStr 'YYYY-MM-DD'
 * @returns {null | {phase:'preview'|'countdown'|'eve'|'today', daysUntil:number, milestone:boolean}}
 *   - 窗口外 / 已过期 → null（不命中，不注入）
 *   - 预热期（8 ≤ daysUntil ≤ leadDays）→ { phase:'preview' }：里程碑日 milestone:true，其余日 milestone:false
 */
function resolveEventPhase(event, todayStr) {
  if (!event || typeof event.date !== 'string') return null;
  const daysUntil = diffDays(todayStr, event.date);
  if (Number.isNaN(daysUntil) || daysUntil < 0) return null;
  const leadDays = Number.isInteger(event.leadDays) && event.leadDays >= 0 ? event.leadDays : DEFAULT_LEAD_DAYS;
  if (daysUntil > leadDays) return null;

  if (daysUntil === 0) return { phase: 'today', daysUntil, milestone: true };
  if (daysUntil === 1) return { phase: 'eve', daysUntil, milestone: true };
  if (daysUntil <= 7) return { phase: 'countdown', daysUntil, milestone: true };
  // 预热期全量命中 preview（v1.1.0 档位修复：此前仅里程碑日命中，其余预热日返回 null，
  // 导致事件在预热窗口内连续多日完全不可见）；milestone 仅标记强注入的里程碑日
  return {
    phase: 'preview',
    daysUntil,
    milestone: daysUntil === leadDays || MILESTONE_DAYS.includes(daysUntil),
  };
}

/**
 * 生成事件文案（模板轮换；avoidText 用于避开与昨天相同的句式）。
 */
function buildEventText(phaseInfo, event, avoidText) {
  const phase = phaseInfo && phaseInfo.phase;
  const templates = EVENT_TEMPLATES[phase] || EVENT_TEMPLATES.countdown;
  const dateText = (event && event.date || '')
    .replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, mo, d) => `${Number(y)}年${Number(mo)}月${Number(d)}日`);
  const title = (event && event.title) || '';
  const n = phaseInfo ? phaseInfo.daysUntil : 0;

  // 随机打乱顺序后取第一个与 avoidText 不同的模板；最多尝试全部
  const pool = shuffle(templates.slice());
  for (const tpl of pool) {
    const text = tpl
      .replace(/\{n\}/g, String(n))
      .replace(/\{title\}/g, title)
      .replace(/\{date\}/g, dateText);
    if (!avoidText || text !== avoidText) return text;
  }
  return pool[0]
    .replace(/\{n\}/g, String(n))
    .replace(/\{title\}/g, title)
    .replace(/\{date\}/g, dateText);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── 时间上下文组装 ──

/**
 * 获取指定日期的可注入时间上下文。
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {null | {phase,daysUntil,milestone}} eventPhase resolveEventPhase 结果（可选）
 * @param {object} [event] 命中的事件文档（buildEventText 需要 title/date）
 * @param {string} [avoidEventText] 昨天已用的赛事句式，用于避开重复
 * @returns {null | {dateLabel:string, anchors:Array<{kind:string,text:string}>}}
 */
function getDateContext(dateStr, eventPhase, event, avoidEventText) {
  const solar = toSolar(dateStr);
  if (!solar) return null;
  const lunar = solar.getLunar();
  const anchors = [];

  // ── 1. 节气 ──
  const todayJieQi = lunar.getJieQi();
  if (todayJieQi) {
    anchors.push({ kind: 'jieqi', text: `今天是${todayJieQi}` });
  } else {
    const prev = lunar.getPrevJieQi();
    const next = lunar.getNextJieQi();
    if (prev && prev.getName && prev.getSolar) {
      const daysSince = diffDays(prev.getSolar().toYmd(), dateStr);
      if (daysSince >= 0 && daysSince <= JIE_QI_NEAR_DAYS) {
        anchors.push({ kind: 'jieqi', text: `${prev.getName()}刚过` });
      }
    }
    if (next && next.getName && next.getSolar) {
      const daysTo = diffDays(dateStr, next.getSolar().toYmd());
      if (daysTo >= 0 && daysTo <= JIE_QI_NEAR_DAYS) {
        anchors.push({ kind: 'jieqi', text: `距离${next.getName()}还有 ${daysTo} 天` });
      }
    }
  }

  // ── 2. 节日（农历 + 公历；当天 + 未来 7 天）──
  const todayFestivals = collectFestivals(solar);
  for (const f of todayFestivals) {
    anchors.push({ kind: 'festival', text: `今天是${f}` });
  }
  for (let i = 1; i <= FESTIVAL_LOOKAHEAD_DAYS; i += 1) {
    const nextDay = solar.next(i);
    for (const f of collectFestivals(nextDay)) {
      anchors.push({ kind: 'festival', text: `距离${f}还有 ${i} 天` });
    }
  }

  // ── 3. 赛事事件（外部已算好档位）──
  if (eventPhase && event) {
    anchors.push({ kind: 'event', text: buildEventText(eventPhase, event, avoidEventText) });
  }

  // 去重（同一天多节日 / 当天与未来重复）
  const seen = new Set();
  const unique = anchors.filter((a) => {
    if (seen.has(a.text)) return false;
    seen.add(a.text);
    return true;
  });

  if (!unique.length) return null;

  return {
    dateLabel: `${solar.getMonth()}月${solar.getDay()}日 星期${WEEK_NAMES[solar.getWeek()]}`,
    anchors: unique,
  };
}

function collectFestivals(solar) {
  const lunar = solar.getLunar();
  const list = [];
  for (const f of lunar.getFestivals() || []) list.push(f); // 农历传统节日全保留
  for (const f of solar.getFestivals() || []) {            // 公历节日走白名单
    if (SOLAR_FESTIVAL_WHITELIST.has(f)) list.push(f);
  }
  return list;
}

module.exports = {
  parseDateStr,
  diffDays,
  resolveEventPhase,
  buildEventText,
  getDateContext,
  DEFAULT_LEAD_DAYS,
  JIE_QI_NEAR_DAYS,
  FESTIVAL_LOOKAHEAD_DAYS,
};
