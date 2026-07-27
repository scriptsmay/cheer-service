'use strict';

/**
 * syncKplCrawl — 定时 Python 数据采集 Job
 * 替代 GitHub Actions daily-fetch.yml，在容器内本地执行 kpl-data-daily 爬虫
 */

const { spawn } = require('child_process');

const KPL_DIR = process.env.KPL_DATA_DIR || '/app/kpl-data-daily';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // e.g. "wetsk/kpl-data-daily"
const GIT_USER = process.env.GIT_USER_NAME || 'KPL Data Bot';
const GIT_EMAIL = process.env.GIT_USER_EMAIL || 'bot@kplwuyan.site';

// derived 文件中每次采集都会刷新的时间戳/元数据字段，不作为数据变更依据
// git diff -I 按行忽略匹配这些模式的变更，只有数据内容真正变化才算
// - generated_at / build_id / updated_at: 每次采集必定刷新的时间戳
// - mtime: manifest.json 中记录的文件修改时间，跟随采集时间变化
// - ai_elapsed_seconds: AI 推理耗时，每次略有不同
// - hash: manifest.json 中各文件的 SHA256，上游时间戳变了 hash 就变（级联噪音）
const TIMESTAMP_IGNORE_PATTERNS = [
  '"generated_at"',
  '"build_id"',
  '"updated_at"',
  '"mtime"',
  '"ai_elapsed_seconds"',
  '"hash"',
];

// AI 生成文件——每次调用 LLM 可能产生不同文本（温度 > 0），不代表源数据有更新
// hasDataChanged 和 gitPush 都排除这些文件的变更检测：
// - 如果只有 AI 文件变了（LLM 随机性 / fallback requestId 变化），不触发 commit
// - 如果真实数据变了，gitPush 仍会 stage+commit AI 文件（随真实数据一起备份）
// - ai-insights.json: AI 生成的洞察文案
// - reports/daily/: AI 生成的日报 markdown（ai_insights.py 同时输出两者）
function isAiGeneratedFile(filepath) {
  if (filepath.endsWith('ai-insights.json')) return true;
  if (filepath.includes('/reports/daily/') || filepath.includes('\\reports\\daily\\')) return true;
  return false;
}

/**
 * 构建 git diff 参数（附加时间戳忽略 -I）
 * @param {string[]} baseArgs - 基础 diff 参数，如 ['diff', '--cached', '--name-only']
 * @returns {string[]}
 */
function buildDiffArgs(baseArgs) {
  const args = [...baseArgs];
  for (const p of TIMESTAMP_IGNORE_PATTERNS) {
    args.push('-I', p);
  }
  return args;
}

// git push 认证方式: SSH(默认) 或 HTTPS+token
// SSH 模式靠容器内 SSH key + GIT_SSH_COMMAND 认证, 不依赖 GITHUB_TOKEN
// HTTPS 模式回退用 token(仅作 fallback, 不推荐: token 会进命令行/日志)
const USE_SSH = (process.env.GITHUB_PUSH_SSH ?? 'true') !== 'false';

/**
 * 解析 Python 可执行文件
 * 优先级: KPL_PYTHON 环境变量 > 平台默认 (Linux: python3 / Windows: python)
 * 不写死 python3，避免换基础镜像或 python 命名不同时硬失效
 */
function resolvePython() {
  if (process.env.KPL_PYTHON) return process.env.KPL_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * 直接 spawn git（不走 shell），避免依赖 cmd.exe / /bin/sh
 * 同时消除把 token 拼进 shell 命令串的隐患
 * @returns {Promise<string>} stdout (trimmed)
 */
function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim().slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * 脱敏: 把 https://x-access-token:xxx@github.com 替换为 https://***@github.com
 * 防止 HTTPS fallback 模式下 token 泄露进日志/错误消息/admin 响应
 */
function maskUrl(text) {
  return text.replace(/(https?:\/\/)[^@]+@/g, '$1***@');
}

/**
 * git push 带重试 — 国内出口到 GitHub 抖动是常态(RST/超时), 重试可显著提升成功率
 * git push 是幂等的(ref 已 up-to-date 时第二次返回成功), 重试安全
 * @param {string} pushTarget - push 目标 (通常是 'origin')
 * @param {string} branch
 * @param {string} cwd
 * @param {number} maxRetries
 * @returns {Promise<string>} push stdout
 */
async function pushWithRetry(pushTarget, branch, cwd, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const out = await runGit(['push', pushTarget, branch], { cwd });
      console.log(`[kpl-crawl] Git push OK (attempt ${i + 1}/${maxRetries})`);
      return out;
    } catch (err) {
      lastErr = err;
      const masked = maskUrl(err.message);
      if (i < maxRetries - 1) {
        const delay = 2000 * (i + 1); // 2s, 4s 递增
        console.warn(`[kpl-crawl] Git push attempt ${i + 1}/${maxRetries} failed: ${masked}; retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(`[kpl-crawl] Git push failed after ${maxRetries} attempts: ${masked}`);
      }
    }
  }
  throw lastErr;
}

/**
 * 执行 Python 脚本并返回结果
 * @param {string} script - Python 脚本路径（相对于 KPL_DIR）
 * @param {string[]} args  - 额外命令行参数
 * @returns {Promise<{ok: boolean, stdout: string, elapsed: number}>}
 */
function runPython(script, args = []) {
  return new Promise((resolve, reject) => {
    const cwd = KPL_DIR;
    const cmd = resolvePython();
    const fullArgs = [script, ...args];

    console.log(`[kpl-crawl] Running: ${cmd} ${fullArgs.join(' ')} (cwd: ${cwd})`);
    const t0 = Date.now();

    const proc = spawn(cmd, fullArgs, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const elapsed = Date.now() - t0;
      if (code === 0) {
        console.log(`[kpl-crawl] ${script} OK (${elapsed}ms)`);
        resolve({ ok: true, stdout: stdout.slice(-500), elapsed });
      } else {
        console.error(`[kpl-crawl] ${script} FAILED (code=${code}, ${elapsed}ms)`);
        reject(new Error(`python ${script} exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      console.error(`[kpl-crawl] ${script} spawn error:`, err.message);
      reject(err);
    });
  });
}

/**
 * git push — 采集完成后自动备份到 GitHub
 * 默认走 SSH(靠容器 SSH key 认证), 可用 GITHUB_PUSH_SSH=false 回退 HTTPS+token
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, hash?: string}>}
 */
async function gitPush() {
  if (!GITHUB_REPO) {
    console.log('[kpl-crawl] Git push skipped: GITHUB_REPO not set');
    return { ok: true, skipped: true, reason: 'missing GITHUB_REPO' };
  }
  if (!USE_SSH && !GITHUB_TOKEN) {
    console.log('[kpl-crawl] Git push skipped: HTTPS mode requires GITHUB_TOKEN');
    return { ok: true, skipped: true, reason: 'missing GITHUB_TOKEN' };
  }

  const cwd = KPL_DIR;
  const pushUrl = USE_SSH
    ? `git@github.com:${GITHUB_REPO}.git`
    : `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
  const method = USE_SSH ? 'SSH' : 'HTTPS';
  const dateStr = new Date().toISOString().split('T')[0];

  try {
    // 1. 确保 git 用户已配置
    await runGit(['config', 'user.name', GIT_USER], { cwd });
    await runGit(['config', 'user.email', GIT_EMAIL], { cwd });

    // 2. stage 所有变更
    await runGit(['add', '-A'], { cwd });

    // 3. 检查是否有真实数据变更（忽略时间戳/元数据字段 + 排除 AI 生成文件）
    // 只有真实数据变化才 commit；纯时间戳刷新或 AI fallback 噪音不提交
    const diffOut = await runGit(buildDiffArgs(['diff', '--cached', '--name-only']), { cwd });
    const allChangedFiles = diffOut.trim().split('\n').filter(Boolean);
    const realChangedFiles = allChangedFiles.filter(f => !isAiGeneratedFile(f));
    if (realChangedFiles.length === 0) {
      console.log(`[kpl-crawl] Git push skipped: no real data changes (${allChangedFiles.length} file(s) with only timestamp/AI noise)`);
      return { ok: true, skipped: true, reason: 'no real data changes' };
    }

    // 4. commit（stage 已包含 AI 文件，随真实数据一起备份）
    console.log(`[kpl-crawl] Git commit (${method}): ${realChangedFiles.length} data file(s) + ${allChangedFiles.length - realChangedFiles.length} AI file(s)`);
    await runGit(['commit', '-m', `auto: daily crawl ${dateStr}`], { cwd });

    // 5. fetch + rebase —— 防止非快进 push 失败
    // deploy.sh 上传的是工作区快照(tar)而非 git clone,容器内仓库可能落后于 origin
    // (例如开发机手动 push 了 fix,或多实例同时采集);此时直接 push 会被拒(non-fast-forward)。
    // fetch 后 rebase 把本地新 commit 重放到最新 origin/<branch> 之上;
    // pushWithRetry 只能扛网络抖动,对版本分叉无效,所以必须在此先对齐。
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    try {
      await runGit(['fetch', 'origin', branch], { cwd });
    } catch (err) {
      // fetch 失败(网络抖动)不阻断 —— pushWithRetry 仍会尝试,最坏只是再失败一次
      console.warn(`[kpl-crawl] git fetch failed (will attempt push anyway): ${err.message}`);
    }
    try {
      const rebaseOut = await runGit(['rebase', `origin/${branch}`], { cwd });
      // origin 无新 commit 时 rebase 是 no-op(退出 0),有新 commit 则重放本地 commit
      if (rebaseOut && !/up to date/i.test(rebaseOut)) {
        console.log(`[kpl-crawl] Rebased onto origin/${branch}: ${rebaseOut.slice(-200)}`);
      }
    } catch (err) {
      // rebase 冲突 —— abort 回到 commit 前,本次跳过 push(不丢数据,下次 cron 重试)
      // 不强行 --continue 或手动解冲突:数据文件冲突需人工判断,自动合并风险高
      console.error(`[kpl-crawl] Rebase conflict, aborting: ${err.message}`);
      try {
        await runGit(['rebase', '--abort'], { cwd });
      } catch (_) {
        /* 可能已不在 rebase 中,忽略 */
      }
      return {
        ok: false,
        skipped: true,
        reason: 'rebase conflict, push skipped',
        error: maskUrl(err.message),
      };
    }

    // 6. push
    // SSH 模式: push 到 'origin' (remote name), git 会自动更新 origin/<branch> 追踪引用
    // HTTPS 模式: 临时把 origin URL 换成带 token 的 URL, push 后恢复原值
    //   (不能用裸 URL 做 push: git push <url> <branch> 不会更新 remote-tracking ref,
    //    导致 git status 误报 "ahead of origin/main", 虽然实际已推上去)
    if (USE_SSH) {
      const pushOut = await pushWithRetry('origin', branch, cwd);
      return { ok: true, hash: pushOut };
    } else {
      // HTTPS fallback: 临时替换 origin URL → push → 恢复
      let origUrl = '';
      try {
        origUrl = await runGit(['remote', 'get-url', 'origin'], { cwd });
      } catch (_) {
        /* origin 可能不存在,忽略 */
      }
      await runGit(['remote', 'set-url', 'origin', pushUrl], { cwd });
      try {
        const pushOut = await pushWithRetry('origin', branch, cwd);
        return { ok: true, hash: pushOut };
      } finally {
        // 恢复原 URL (防止 token 残留在 git config)
        if (origUrl) {
          await runGit(['remote', 'set-url', 'origin', origUrl], { cwd }).catch(() => {});
        }
      }
    }
  } catch (err) {
    const masked = maskUrl(err.message);
    console.error('[kpl-crawl] Git push FAILED:', masked);
    return { ok: false, error: masked };
  }
}

/**
 * 检测采集后数据是否有变更
 * 用 git diff --cached 检测；git 不可用时 fallback 为 true（保守策略：宁可多同步不漏）
 * @param {string} cwd - git 仓库目录
 * @returns {Promise<boolean>}
 */
async function hasDataChanged(cwd) {
  try {
    await runGit(['add', '-A'], { cwd });
    const diffOut = await runGit(buildDiffArgs(['diff', '--cached', '--name-only']), { cwd });
    const allFiles = diffOut.trim().split('\n').filter(Boolean);
    // 排除 AI 生成文件——LLM 每次调用可能产生不同文本，不代表源数据有更新
    const files = allFiles.filter(f => !isAiGeneratedFile(f));
    const changed = files.length > 0;
    if (allFiles.length !== files.length) {
      console.log(`[kpl-crawl] Ignored ${allFiles.length - files.length} AI-generated file(s) in change detection`);
    }
    console.log(`[kpl-crawl] Data changed: ${changed} (${files.length} file(s))`);
    return changed;
  } catch (err) {
    console.warn('[kpl-crawl] Cannot detect data changes, assuming changed:', err.message);
    return true;
  }
}

/**
 * 采集前同步远程代码 —— 拉取 origin 最新提交,确保用最新 .py 脚本采集
 * deploy.sh 上传的是工作区快照(tar),容器内代码可能落后于 origin
 * (例如开发机 push 了 Referer/player_info 修复);采集前先 rebase 到最新,
 * 既能用修复后的代码采集,又让采集后 push 几乎不会遇到非快进问题。
 *
 * 冲突策略:rebase 冲突时 abort,保留本地状态继续采集(降级,不阻断核心任务)
 * —— 采集后 gitPush 内的 rebase 会再次尝试对齐
 * fetch 网络失败也不阻断:用本地代码采集,push 时再重试
 *
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>}
 */
async function gitSyncBeforeCrawl() {
  if (!GITHUB_REPO) {
    return { ok: true, skipped: true, reason: 'missing GITHUB_REPO' };
  }
  const cwd = KPL_DIR;
  try {
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    await runGit(['fetch', 'origin', branch], { cwd });
    const rebaseOut = await runGit(['rebase', `origin/${branch}`], { cwd });
    if (rebaseOut && !/up to date/i.test(rebaseOut)) {
      console.log(`[kpl-crawl] Pre-crawl sync: rebased onto origin/${branch}`);
    } else {
      console.log('[kpl-crawl] Pre-crawl sync: already up to date');
    }
    return { ok: true };
  } catch (err) {
    const masked = maskUrl(err.message);
    // rebase 冲突 → abort 回退,继续用本地代码采集(不阻断采集)
    if (/rebase|conflict/i.test(err.message)) {
      console.warn(`[kpl-crawl] Pre-crawl sync: rebase conflict, aborting: ${masked}`);
      try {
        await runGit(['rebase', '--abort'], { cwd });
      } catch (_) {
        /* 可能已不在 rebase 中,忽略 */
      }
    } else {
      // fetch 网络失败等 → 继续(采集后 gitPush 会再尝试)
      console.warn(`[kpl-crawl] Pre-crawl sync failed (continue with local code): ${masked}`);
    }
    return { ok: false, skipped: true, reason: masked };
  }
}

/**
 * 主采集任务 — 替代 GH Actions daily-fetch
 * 0. git sync               (采集前拉取最新代码,见 gitSyncBeforeCrawl)
 * 1. python main.py          (数据采集 + AI 后处理)
 * 2. python fetch-schedule.py (赛程采集)
 * 3. 检测数据变更             (git diff，供调用方决定是否入库)
 * 4. git push                (备份到 GitHub，含 fetch+rebase 对齐)
 *
 * @returns {Promise<{sync, main, schedule, git, hasChanges: boolean}>}
 */
async function syncKplCrawl() {
  const results = { sync: null, main: null, schedule: null, git: null, hasChanges: false };

  // 采集前同步远程代码:确保用最新 .py 脚本采集 + 降低后续 push 冲突概率
  results.sync = await gitSyncBeforeCrawl();

  try {
    results.main = await runPython('main.py');
  } catch (e) {
    console.error('[kpl-crawl] main.py error:', e.message);
    results.main = { ok: false, error: e.message };
  }

  try {
    results.schedule = await runPython('scripts/fetch-schedule.py');
  } catch (e) {
    console.error('[kpl-crawl] fetch-schedule.py error:', e.message);
    results.schedule = { ok: false, error: e.message };
  }

  // 检测采集后数据是否有变更（在 git push 之前，独立检测不依赖 push 结果）
  results.hasChanges = await hasDataChanged(KPL_DIR);

  // 采集完成后自动 git push
  results.git = await gitPush();

  return results;
}

module.exports = { syncKplCrawl, runPython, gitPush };
