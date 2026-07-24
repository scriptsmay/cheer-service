'use strict';

/**
 * syncKplCrawl — 定时 Python 数据采集 Job
 * 替代 GitHub Actions daily-fetch.yml，在容器内本地执行 kpl-data-daily 爬虫
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const KPL_DIR = process.env.KPL_DATA_DIR || '/app/kpl-data-daily';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // e.g. "wetsk/kpl-data-daily"
const GIT_USER = process.env.GIT_USER_NAME || 'KPL Data Bot';
const GIT_EMAIL = process.env.GIT_USER_EMAIL || 'bot@kplwuyan.site';

/**
 * 执行 Python 脚本并返回结果
 * @param {string} script - Python 脚本路径（相对于 KPL_DIR）
 * @param {string[]} args  - 额外命令行参数
 * @returns {Promise<{ok: boolean, stdout: string, elapsed: number}>}
 */
function runPython(script, args = []) {
  return new Promise((resolve, reject) => {
    const cwd = KPL_DIR;
    const cmd = 'python3';
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
 * 使用 GITHUB_TOKEN 认证，不会修改 permanent remote config
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, hash?: string}>}
 */
async function gitPush() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('[kpl-crawl] Git push skipped: GITHUB_TOKEN or GITHUB_REPO not set');
    return { ok: true, skipped: true, reason: 'missing env vars' };
  }

  const cwd = KPL_DIR;
  const pushUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
  const dateStr = new Date().toISOString().split('T')[0];

  try {
    // 1. 确保 git 用户已配置
    await execAsync(`git config user.name "${GIT_USER}"`, { cwd });
    await execAsync(`git config user.email "${GIT_EMAIL}"`, { cwd });

    // 2. stage 所有变更
    await execAsync('git add -A', { cwd });

    // 3. 检查是否有变更
    const { stdout: diffOut } = await execAsync('git diff --cached --name-only', { cwd });
    if (!diffOut.trim()) {
      console.log('[kpl-crawl] Git push skipped: no changes');
      return { ok: true, skipped: true, reason: 'no changes' };
    }

    // 4. commit
    const changedFiles = diffOut.trim().split('\n').length;
    console.log(`[kpl-crawl] Git commit: ${changedFiles} file(s) changed`);
    await execAsync(`git commit -m "auto: daily crawl ${dateStr}"`, { cwd });

    // 5. push（使用一次性 token URL，不改 permanent remote）
    const branch = (await execAsync('git rev-parse --abbrev-ref HEAD', { cwd })).stdout.trim();
    const { stdout: pushOut } = await execAsync(
      `git push "${pushUrl}" ${branch}`,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );

    console.log(`[kpl-crawl] Git push OK: ${pushOut.trim().split('\n').pop()}`);
    return { ok: true, hash: pushOut.trim() };
  } catch (err) {
    console.error('[kpl-crawl] Git push FAILED:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * 主采集任务 — 替代 GH Actions daily-fetch
 * 1. python main.py          (数据采集 + AI 后处理)
 * 2. python fetch-schedule.py (赛程采集)
 * 3. git push                (备份到 GitHub)
 */
async function syncKplCrawl() {
  const results = { main: null, schedule: null, git: null };

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

  // 采集完成后自动 git push
  results.git = await gitPush();

  return results;
}

module.exports = { syncKplCrawl, runPython, gitPush };
