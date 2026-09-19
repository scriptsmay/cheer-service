'use strict';

/**
 * 定时任务定义 — scheduler.js 与 admin 状态接口共享的单一数据源
 * 避免 cron 表达式在多处重复硬编码，同时供管理页面展示任务时间
 *
 * KPL 数据采集由宿主机 systemd timer 负责（业务分离），此处 cron 均为容器内
 * 固定值，不提供运行时修改入口；调整采集/赛程节奏请改 kpl-data-daily 的 timer。
 */

const cronParser = require('cron-parser');

const SCHEDULES = [
  {
    key: 'kpl_crawl',
    name: 'KPL 数据同步',
    cron: '0 9 * * *',
    description: '每天 09:00 读取宿主机 timer 采集落盘的数据并同步到 MongoDB（采集节奏由宿主机 systemd timer 管理）',
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

// 返回给前端的任务列表
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
