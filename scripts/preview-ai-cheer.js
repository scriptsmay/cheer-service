'use strict';

/**
 * AI 应援文案本地预览脚本
 *
 * 从 TCB CloudBase 的 preview-ai-cheer 迁移而来，
 * 适配新架构：MongoDB + OpenAI 兼容 API。
 *
 * 用法（在 cheer-service 根目录执行）：
 *   node scripts/preview-ai-cheer.js --mood daily --count 3
 *   node scripts/preview-ai-cheer.js --mood low --count 5 --text "最近有点低谷"
 *   node scripts/preview-ai-cheer.js --mood hope --count 3 --no-data
 *
 * 可选覆盖 AI 配置（不指定则用 .env 或 ai-config.json）：
 *   --base-url https://api.deepseek.com/v1
 *   --api-key sk-xxxxxxxx
 *   --model deepseek-chat
 */

const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const serverSrc = path.join(projectRoot, 'server', 'src');

// ── 导入 cheer 核心逻辑 ──
const cheerExports = require(path.join(serverSrc, 'routes', 'cheer'));
const {
  buildGroundedSource,
  buildSystemPrompt,
  buildUserPrompt,
  parseGeneratedText,
  inspectGeneratedOutput,
  getLatestOverview,
} = cheerExports.__test || cheerExports;

// ── 导入数据处理层 ──
const { collection, close: closeDb } = require(path.join(serverSrc, 'db', 'mongo'));
const { getEffectiveConfig } = require(path.join(serverSrc, 'services', 'ai-config'));

// ── 工具 ──
const { textLength } = require(path.join(serverSrc, 'utils', 'helpers'));

const ALLOWED_MOODS = new Set(['victory', 'low', 'daily', 'hope']);
const TRACKED_TERMS = ['同担', '守护', '冲冲冲', '杀回来'];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  // 读取 AI 配置（优先 ai-config.json → 环境变量，CLI 参数可覆盖）
  const aiConfig = getEffectiveConfig();
  const baseUrl = options.baseUrl || aiConfig.baseUrl;
  const apiKey = options.apiKey || aiConfig.apiKey;
  const model = options.model || aiConfig.model;

  console.log('════════════════════════════════════');
  console.log('AI 应援文案预览');
  console.log('════════════════════════════════════');
  console.log(`配置来源：${aiConfig._source === 'file' ? 'ai-config.json' : '环境变量'}`);
  console.log(`Base URL：${baseUrl}`);
  console.log(`Model：${model}`);
  console.log(`心情：${options.mood}`);
  console.log(`生成次数：${options.count}`);
  if (options.text) console.log(`补充文字：${options.text}`);

  // 加载赛季数据
  const overview = options.useData ? await getLatestOverview() : null;
  const source = buildGroundedSource(overview);
  console.log(`可引用数据：${source.promptLines.length ? source.promptLines.join('；') : '无（纯情绪模式）'}`);

  if (options.showPrompt) {
    const sysPrompt = buildSystemPrompt(options.mood, source);
    const usrPrompt = buildUserPrompt(options.mood, options.text, source);
    console.log('\n── 系统提示词 ──\n');
    console.log(sysPrompt);
    console.log('\n── 用户提示词 ──\n');
    console.log(usrPrompt);
    console.log('── 提示词结束 ──\n');
  }

  // 构造临时 generateText（覆盖 AI 配置）
  const generateText = await createGenerateText({ baseUrl, apiKey, model });

  let successCount = 0;
  let failCount = 0;
  let totalTokens = 0;

  for (let index = 1; index <= options.count; index += 1) {
    const messages = [
      { role: 'system', content: buildSystemPrompt(options.mood, source) },
      { role: 'user', content: buildUserPrompt(options.mood, options.text, source) },
    ];

    let result;
    try {
      result = await generateText({ messages, temperature: 0.85, jsonMode: true });
    } catch (error) {
      console.log(`\n[${options.mood} ${index}] ❌ AI 调用失败`);
      console.log(`错误：${error.message}`);
      failCount += 1;
      continue;
    }

    const parsed = parseGeneratedText(result.text);
    const usage = result.usage || {};
    const tokens = Number(usage.total_tokens || 0);
    totalTokens += tokens;

    if (!parsed) {
      console.log(`\n[${options.mood} ${index}] ❌ JSON 解析失败`);
      console.log(`原始输出：${String(result.text).slice(0, 300)}`);
      failCount += 1;
      continue;
    }

    const validation = inspectGeneratedOutput(parsed, source);
    if (!validation.ok) {
      console.log(`\n[${options.mood} ${index}] ❌ 校验未通过 (${validation.reason})`);
      console.log(`原始输出：${JSON.stringify(parsed, null, 2)}`);
      failCount += 1;
      continue;
    }

    // 通过校验
    console.log(`\n[${options.mood} ${index}] ✅`);
    validation.output.lines.forEach((line, lineIndex) => {
      console.log(`  ${lineIndex + 1}. ${line}（${textLength(line)} 字）`);
    });
    console.log(`  caption: ${validation.output.emoji_caption}`);
    console.log(`  词频：${formatTermCounts([...validation.output.lines, validation.output.emoji_caption].join(''))}`);
    console.log(`  Tokens：${tokens || '未返回'}`);
    successCount += 1;
  }

  console.log('\n════════════════════════════════════');
  console.log(`完成：${successCount}/${successCount + failCount} 组通过校验`);
  console.log(`总 Tokens：${totalTokens || '未返回'}`);
  console.log('════════════════════════════════════');

  await closeDb();
  if (failCount > 0) process.exitCode = 1;
}

// ── 构造带覆写的 generateText 函数 ──
async function createGenerateText(override) {
  // 直接内联实现，不依赖 ai.js 中的 AbortSignal.timeout（增加超时到 60s）
  const { baseUrl, apiKey, model } = override;

  return async function ({ messages, temperature = 0.85, jsonMode = false }) {
    const body = { model, messages, temperature };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // 60s 超时，preview 场景给足够时间
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AI API error ${response.status}: ${errText.slice(0, 500)}`);
    }

    const data = await response.json();
    console.log(`AI API 调用成功，返回：────────────\n${JSON.stringify(data)}`);
    console.log('───────────────────────────────');
    const msg = data.choices?.[0]?.message;
    return {
      text: msg?.content || msg?.reasoning_content || '',
      usage: {
        total_tokens: data.usage?.total_tokens || 0,
        prompt_tokens: data.usage?.prompt_tokens || 0,
        completion_tokens: data.usage?.completion_tokens || 0,
      },
    };
  };
}

// ── CLI 参数解析 ──
function parseArgs(args) {
  const options = {
    mood: 'daily',
    count: 2,
    text: '',
    useData: true,
    showPrompt: true,
    help: false,
    baseUrl: '',
    apiKey: '',
    model: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--no-data') {
      options.useData = false;
    } else if (arg === '--no-prompt') {
      options.showPrompt = false;
    } else if (arg === '--show-prompt') {
      options.showPrompt = true;
    } else if (arg === '--mood') {
      options.mood = readOptionValue(args, ++index, '--mood');
    } else if (arg === '--count') {
      options.count = Number(readOptionValue(args, ++index, '--count'));
    } else if (arg === '--text') {
      options.text = readOptionValue(args, ++index, '--text');
    } else if (arg === '--base-url') {
      options.baseUrl = readOptionValue(args, ++index, '--base-url');
    } else if (arg === '--api-key') {
      options.apiKey = readOptionValue(args, ++index, '--api-key');
    } else if (arg === '--model') {
      options.model = readOptionValue(args, ++index, '--model');
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  if (!ALLOWED_MOODS.has(options.mood)) {
    throw new Error(`--mood 必须是 ${[...ALLOWED_MOODS].join('、')} 之一`);
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 20) {
    throw new Error('--count 必须是 1 到 20 之间的整数');
  }
  if (textLength(options.text) > 120) {
    throw new Error('--text 不能超过 120 个字符');
  }

  return options;
}

function readOptionValue(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
  return value;
}

// ── 词频统计 ──
function formatTermCounts(text) {
  return TRACKED_TERMS.map((term) => `${term} ${countOccurrences(text, term)} 次`).join('，');
}

function countOccurrences(text, term) {
  return text.split(term).length - 1;
}

// ── 帮助 ──
function printHelp() {
  console.log(`AI 应援文案本地预览

用法：node scripts/preview-ai-cheer.js [选项]

选项：
  --mood <mood>      victory、low、daily、hope，默认 daily
  --count <n>        生成次数，1 到 20，默认 2
  --text <text>      用户补充内容，最多 120 个字符
  --no-data          不读取赛季数据，生成纯情绪文案
  --no-prompt        不输出提示词
  --show-prompt      输出实际发送给模型的提示词（默认开启）
  --base-url <url>   覆盖 AI API 地址
  --api-key <key>    覆盖 AI API Key
  --model <model>    覆盖模型名称
  --help, -h         显示帮助

示例：
  node --env-file=.env scripts/preview-ai-cheer.js --mood victory --count 3
  node --env-file=.env scripts/preview-ai-cheer.js --mood low --text "有点低迷" --count 5
  node --env-file=.env scripts/preview-ai-cheer.js --mood hope --count 3 --no-data
  node --env-file=.env scripts/preview-ai-cheer.js --mood daily --base-url https://api.deepseek.com/v1 --api-key sk-xxx --model deepseek-chat`);
}

main().catch((error) => {
  console.error(`预览失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
