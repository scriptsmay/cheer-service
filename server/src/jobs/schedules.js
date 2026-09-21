'use strict';

/**
 * 定时任务定义 — scheduler.js 的单一数据源
 *
 * KPL 数据采集由宿主机 systemd timer 负责（业务分离），此处 cron 均为容器内
 * 固定值，不提供运行时修改入口；调整采集/赛程节奏请改 kpl-data-daily 的 timer。
 * Vercel 部署下 SCHEDULER_ENABLED=false，任务由 /api/cron/daily 合并触发。
 */

const SCHEDULES = [
  {
    key: 'kpl_crawl',
    cron: '0 9 * * *',
  },
  {
    key: 'cleanup_ai',
    cron: '20 3 * * *',
  },
];

// 以 { key: cron } 形式导出，供 scheduler.js 直接引用
const CRON = Object.fromEntries(SCHEDULES.map((s) => [s.key, s.cron]));

module.exports = { CRON };
