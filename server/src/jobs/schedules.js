'use strict';

/**
 * 定时任务定义 — scheduler.js 与 admin 状态接口共享的单一数据源
 * 避免 cron 表达式在多处重复硬编码，同时供管理页面展示采集时间
 */

const cronParser = require('cron-parser');

const SCHEDULES = [
  {
    key: 'kpl_crawl',
    name: 'KPL 全量采集',
    cron: '0 3,9,15,21 * * *',
    description: '每天 03:00 / 09:00 / 15:00 / 21:00 触发 Python 爬虫采集赛季概览与赛程',
    category: 'collection',
  },
  {
    key: 'kpl_live',
    name: '赛程实时同步',
    cron: '*/10 * * * *',
    description: '每 10 分钟同步一次实时赛程状态',
    category: 'collection',
  },
  {
    key: 'weekly_story',
    name: '周报生成',
    cron: '0 5 * * 1',
    description: '每周一 05:00 生成选手周报',
    category: 'job',
  },
  {
    key: 'cleanup_ai',
    name: 'AI 报告清理',
    cron: '20 3 * * *',
    description: '每天 03:20 清理 90 天前的 AI 报告',
    category: 'job',
  },
];

// 计算下一次执行时间（Asia/Shanghai 时区，返回 ISO 字符串；失败返回 null）
function getNextRun(cronExpr) {
  try {
    const interval = cronParser.parseExpression(cronExpr, { tz: 'Asia/Shanghai' });
    return interval.next().toISOString();
  } catch (e) {
    return null;
  }
}

// 返回给前端的任务列表（withNextRun=true 时附带下次执行时间）
function getScheduleList(withNextRun = false) {
  return SCHEDULES.map((s) => ({
    key: s.key,
    name: s.name,
    cron: s.cron,
    description: s.description,
    category: s.category,
    next_run: withNextRun ? getNextRun(s.cron) : undefined,
  }));
}

// 以 { key: cron } 形式导出，供 scheduler.js 直接引用
const CRON = Object.fromEntries(SCHEDULES.map((s) => [s.key, s.cron]));

module.exports = { SCHEDULES, CRON, getScheduleList, getNextRun };
