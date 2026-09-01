'use strict';

/**
 * cheer-dup-report.js — 应援文案重复率量化周报（v1.1.0 Task 7）
 *
 * 读近 N 天 ai_reports（module=aiCheer，按 created_at 升序），统计：
 *  - 开头精确重复率：与窗口内更早输出开头 8 字指纹相同的输出占比（对应 Task 4 校验口径）
 *  - 开头 bigram 重合率：两两输出开头（前 8 字）2-gram 集合的平均 Jaccard 相似度（样本 >300 时取最近 300 条）
 *  - 句首 top10：出现最多的开头指纹及次数（公式化预警）
 *  - 角色覆盖率：roles 字段（v1.1.0 Task 5 起记录）各角色出现占比 + 平均去重角色数
 *  - prompt_version 分布：效果归因切片（v1.1.0 Task 3 起记录）
 *
 * 用法（在 cheer-service 根目录执行）：
 *   npm run report:cheer-dup                                   # 默认 14/30 天双窗口，输出到 stdout
 *   npm run report:cheer-dup -- --days 30 --out /tmp/dup.md    # 指定窗口与落盘文件
 *   npm run report:cheer-dup -- --subject <subjectId>          # 只统计单用户
 *
 * 推飞书：预留 --feishu-webhook <url>（POST Markdown 文本），未配置时仅 stdout/落盘。
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const { collection, close, command } = require(path.join(projectRoot, 'server', 'src', 'db', 'mongo'));
const { shanghaiDate } = require(path.join(projectRoot, 'server', 'src', 'utils', 'helpers'));

const OPENING_CHARS = 8;      // 与 cheer.js 开头指纹口径一致
const BIGRAM_SAMPLE_CAP = 300; // 两两比对的样本上限，防 O(n²) 爆炸
const QUERY_LIMIT = 2000;      // 单窗口最大拉取量

function parseArgs(argv) {
  const options = { days: [14, 30], out: '', subject: '', feishuWebhook: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') {
      options.days = String(argv[++i]).split(',').map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    } else if (arg === '--out') {
      options.out = String(argv[++i] || '');
    } else if (arg === '--subject') {
      options.subject = String(argv[++i] || '');
    } else if (arg === '--feishu-webhook') {
      options.feishuWebhook = String(argv[++i] || '');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }
  return options;
}

function printHelp() {
  console.log(`用法：npm run report:cheer-dup [-- --days 14,30] [--out file.md] [--subject id] [--feishu-webhook url]`);
}

/** 输出开头指纹：首行去空白后取前 8 字（与 cheer.js extractOpening 口径一致，不去标点以保持独立实现简单） */
function openingOf(doc) {
  const lines = doc && doc.ai_output && Array.isArray(doc.ai_output.lines) ? doc.ai_output.lines : [];
  const first = lines.find((line) => typeof line === 'string' && line.trim());
  return first ? first.trim().slice(0, OPENING_CHARS) : '';
}

function bigramSet(str) {
  const set = new Set();
  for (let i = 0; i < str.length - 1; i += 1) set.add(str.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

async function collectReports(days, subject) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const filter = { module: 'aiCheer', created_at: command.gte(cutoff) };
  if (subject) filter.subject_id = subject;
  const col = await collection('ai_reports');
  const result = await col.where(filter).orderBy('created_at', 'asc').limit(QUERY_LIMIT).get();
  return result.data || [];
}

function analyze(docs) {
  const openings = [];
  const seen = new Set();
  let duplicateCount = 0;
  for (const doc of docs) {
    const opening = openingOf(doc);
    if (!opening) continue;
    openings.push(opening);
    if (seen.has(opening)) duplicateCount += 1;
    else seen.add(opening);
  }
  const openingDupRate = openings.length ? duplicateCount / openings.length : 0;

  // 两两 bigram 相似度（样本超限时取最近 300 条，窗口内最新口径）
  const sample = openings.length > BIGRAM_SAMPLE_CAP ? openings.slice(-BIGRAM_SAMPLE_CAP) : openings;
  const gramSets = sample.map(bigramSet);
  let pairCount = 0;
  let pairSum = 0;
  for (let i = 0; i < gramSets.length; i += 1) {
    for (let j = i + 1; j < gramSets.length; j += 1) {
      pairCount += 1;
      pairSum += jaccard(gramSets[i], gramSets[j]);
    }
  }
  const bigramOverlap = pairCount ? pairSum / pairCount : 0;

  const counts = new Map();
  for (const opening of openings) counts.set(opening, (counts.get(opening) || 0) + 1);
  const top10 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // 角色覆盖率（v1.1.0 Task 5 起记录 roles；历史报告无该字段不计入）
  const withRoles = docs.filter((d) => Array.isArray(d.roles) && d.roles.length);
  const roleCounts = new Map();
  for (const doc of withRoles) {
    for (const role of new Set(doc.roles)) roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
  }
  const roleCoverage = [...roleCounts.entries()]
    .map(([role, n]) => ({ role, n, rate: withRoles.length ? n / withRoles.length : 0 }))
    .sort((a, b) => b.rate - a.rate);
  const meanDistinctRoles = withRoles.length
    ? withRoles.reduce((sum, d) => sum + new Set(d.roles).size, 0) / withRoles.length
    : 0;

  // prompt_version 分布（v1.1.0 Task 3 起记录）
  const versions = new Map();
  for (const doc of docs) {
    const key = doc.prompt_version === undefined ? '无字段（升级前）' : String(doc.prompt_version);
    versions.set(key, (versions.get(key) || 0) + 1);
  }

  const subjects = new Set(docs.map((d) => d.subject_id).filter(Boolean));

  return {
    total: docs.length,
    subjects: subjects.size,
    openingDupRate,
    duplicateCount,
    bigramOverlap,
    top10,
    withRoles: withRoles.length,
    roleCoverage,
    meanDistinctRoles,
    versions,
  };
}

function rate(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function toMarkdown(days, stats) {
  const lines = [`## 近 ${days} 天窗口`];
  lines.push(`- 报告数：${stats.total}（覆盖用户 ${stats.subjects}）`);
  lines.push(`- 开头精确重复率：**${rate(stats.openingDupRate)}**（${stats.duplicateCount}/${stats.total}，与窗口内更早输出开头 ${OPENING_CHARS} 字相同）`);
  lines.push(`- 开头 bigram 重合率（平均 Jaccard，样本 ≤${BIGRAM_SAMPLE_CAP}）：**${rate(stats.bigramOverlap)}**`);

  if (stats.top10.length) {
    lines.push(`- 句首 top10：`);
    for (const [opening, n] of stats.top10) lines.push(`  - 「${opening}」× ${n}`);
  } else {
    lines.push('- 句首 top10：无数据');
  }

  lines.push(`- 角色覆盖率（有 roles 字段的报告 ${stats.withRoles} 条，平均去重角色 ${stats.meanDistinctRoles.toFixed(2)}/组）：`);
  if (stats.roleCoverage.length) {
    for (const { role, n, rate: r } of stats.roleCoverage) lines.push(`  - ${role}：${rate(r)}（${n}）`);
  } else {
    lines.push('  - 无 roles 字段数据（v1.1.0 部署后积累）');
  }

  const versionLines = [...stats.versions.entries()].sort().map(([v, n]) => `  - prompt_version ${v}：${n} 条`);
  lines.push(`- prompt_version 分布：\n${versionLines.join('\n')}`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.days.length) {
    printHelp();
    return;
  }

  console.error(`[cheer-dup-report] 统计窗口：${options.days.join('/')} 天${options.subject ? `（subject=${options.subject}）` : ''}`);
  const sections = [];
  for (const days of options.days) {
    const docs = await collectReports(days, options.subject);
    console.error(`[cheer-dup-report] 近 ${days} 天拉取 ${docs.length} 条报告`);
    sections.push(toMarkdown(days, analyze(docs)));
  }

  const now = new Date();
  const report = [
    `# 应援文案重复率周报`,
    '',
    `- 生成时间：${shanghaiDate().date} ${now.toTimeString().slice(0, 8)}（Asia/Shanghai）`,
    `- 统计口径：ai_reports / module=aiCheer / created_at 窗口内，开头指纹 = 首行前 ${OPENING_CHARS} 字`,
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');

  if (options.out) {
    fs.writeFileSync(options.out, report, 'utf8');
    console.error(`[cheer-dup-report] 已写入 ${options.out}`);
  }

  if (options.feishuWebhook) {
    // 预留：飞书自定义机器人 webhook（POST 文本）。未在知识库登记 webhook 前不启用。
    console.error('[cheer-dup-report] feishu-webhook 已预留，当前版本未实现推送（避免未授权外发）');
  }

  process.stdout.write(report);
  await close();
}

module.exports = { analyze, openingOf, bigramSet, jaccard, toMarkdown };

/* istanbul ignore next */
if (require.main === module) {
  main().catch(async (error) => {
    console.error('[cheer-dup-report] failed:', error.message);
    try { await close(); } catch (_) { /* ignore */ }
    process.exitCode = 1;
  });
}
