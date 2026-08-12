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
    cron: '0 9 * * *',
    description: '每天 09:00 触发 Python 爬虫采集赛季概览与赛程（频率可在管理页面调整）',
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

// 校验 cron 表达式合法性（同时用 cron-parser 与 node-cron validate 确保一致性）
// cron-parser 比 node-cron 宽松（支持 L/#/?/W），而 node-cron 是实际调度器，
// 二者都通过才合法，避免毒 cron 落库后重启时 cron.schedule 抛错导致服务崩溃
const cron = require('node-cron');

const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟最小间隔

function assertValidCron(cronExpr) {
  // node-cron 校验（与调度器一致，拒绝 L/#/?/W 等不支持的语法）
  if (!cron.validate(cronExpr)) {
    throw new Error(`node-cron 不支持的 cron 表达式: ${cronExpr}`);
  }
  // cron-parser 校验并计算频率
  const interval = cronParser.parseExpression(cronExpr, { tz: 'Asia/Shanghai' });
  const t1 = interval.next().getTime();
  const t2 = interval.next().getTime();
  if (t2 - t1 < MIN_INTERVAL_MS) {
    throw new Error(
      `cron 执行间隔不能小于 5 分钟（当前约 ${Math.round((t2 - t1) / 1000)}秒）`
    );
  }
  return cronExpr;
}

// 返回给前端的任务列表
// overrides: { [key]: cronExpr } — 运行时（app_config）覆盖值，优先于 SCHEDULES 常量
function getScheduleList(withNextRun = false, overrides = {}) {
  return SCHEDULES.map((s) => {
    const cronExpr = overrides[s.key] || s.cron;
    return {
      key: s.key,
      name: s.name,
      cron: cronExpr,
      description: s.description,
      category: s.category,
      next_run: withNextRun ? getNextRun(cronExpr) : undefined,
    };
  });
}

// 以 { key: cron } 形式导出，供 scheduler.js 直接引用
const CRON = Object.fromEntries(SCHEDULES.map((s) => [s.key, s.cron]));

module.exports = { SCHEDULES, CRON, getScheduleList, getNextRun, assertValidCron };
