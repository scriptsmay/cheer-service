'use strict';

/**
 * syncKplCrawl — KPL 数据同步任务
 * 
 * 数据流程（业务分离架构）:
 * 1. systemd timer (txyun 服务器) → 执行 Python 爬虫 → 写入本地文件 → git push 到 GitHub
 * 2. cheer-service 容器 → 读取挂载的本地文件 → 同步到 MongoDB
 * 
 * 容器内不再执行 git 操作，职责分离:
 * - kpl-data-daily 仓库：负责数据采集 + Git 备份（宿主机 systemd timer）
 * - cheer-service 容器：负责业务逻辑 + MongoDB 存储（只读文件挂载）
 */

const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');

const KPL_DATA_DIR = process.env.KPL_DATA_DIR || '/app/kpl-data-daily';
const UPTIME_PUSH_URL = process.env.UPTIME_PUSH_URL || '';

/**
 * 上报 Uptime Kuma push 心跳（fire-and-forget，不阻塞主流程）
 * @param {boolean} ok - 主采集 main.py 是否成功
 * @param {string} msg - 附加信息
 */
function sendUptimeHeartbeat(ok, msg) {
  if (!UPTIME_PUSH_URL) return;
  try {
    const url = new URL(UPTIME_PUSH_URL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console.error(`[kpl-crawl] Uptime heartbeat error: unsupported protocol ${url.protocol}`);
      return;
    }
    url.searchParams.set('status', ok ? 'up' : 'down');
    url.searchParams.set('msg', (msg || (ok ? 'OK' : 'FAIL')).slice(0, 80));
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { timeout: 10000 }, (res) => {
      res.resume();
      console.log(`[kpl-crawl] Uptime heartbeat sent (${res.statusCode})`);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => console.error('[kpl-crawl] Uptime heartbeat error:', e.message));
  } catch (e) {
    console.error('[kpl-crawl] Uptime heartbeat error:', e.message);
  }
}

/**
 * 检查文件是否有变更（基于修改时间）
 * @param {string} dataDir - KPL 数据目录
 * @returns {Promise<boolean>}
 */
async function checkFileChanges(dataDir) {
  try {
    const lastSyncFile = path.join(dataDir, '.last_sync_timestamp');
    let lastSyncTime = 0;
    
    // 读取上次同步时间
    try {
      const timestamp = await fs.readFile(lastSyncFile, 'utf8');
      lastSyncTime = parseInt(timestamp.trim(), 10);
    } catch {
      // 首次同步，无时间戳文件
    }
    
    // 检查关键文件的修改时间
    const filesToCheck = [
      path.join(dataDir, 'data', 'derived', 'KPL2026S2', 'overview.json'),
      path.join(dataDir, 'data', 'raw', 'schedule.json')
    ];
    
    for (const file of filesToCheck) {
      try {
        const stats = await fs.stat(file);
        if (stats.mtimeMs > lastSyncTime) {
          console.log(`[syncKplCrawl] File changed: ${file} (mtime: ${stats.mtimeMs})`);
          return true;
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`[syncKplCrawl] Failed to stat ${file}:`, err.message);
        }
      }
    }
    
    console.log('[syncKplCrawl] No data changes detected');
    return false;
    
  } catch (error) {
    console.warn('[syncKplCrawl] Error checking file changes:', error.message);
    return true;
  }
}

/**
 * 更新最后同步时间戳
 * @param {string} dataDir - KPL 数据目录
 */
async function updateLastSyncTime(dataDir) {
  const lastSyncFile = path.join(dataDir, '.last_sync_timestamp');
  await fs.writeFile(lastSyncFile, Date.now().toString());
}

/**
 * 辅助函数：检查文件是否存在
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 主同步任务 — 读取挂载的数据文件并同步到 MongoDB
 * 
 * 数据流程:
 * 1. 检测文件是否有变更（基于修改时间）
 * 2. 读取最新数据
 * 3. 同步到 MongoDB
 * 4. 更新最后同步时间戳
 * 
 * @returns {Promise<{hasChanges: boolean, synced: boolean, error?: string}>}
 */
async function syncKplCrawl() {
  const result = { hasChanges: false, synced: false };
  
  console.log(`[syncKplCrawl] Starting data sync from ${KPL_DATA_DIR}`);
  
  try {
    // 1. 检测文件变更
    const hasChanges = await checkFileChanges(KPL_DATA_DIR);
    result.hasChanges = hasChanges;
    
    if (!hasChanges) {
      console.log('[syncKplCrawl] No data changes, skipping...');
      return result;
    }
    
    // 2. 读取最新数据
    const overviewPath = path.join(KPL_DATA_DIR, 'data', 'derived', 'KPL2026S2', 'overview.json');
    const schedulePath = path.join(KPL_DATA_DIR, 'data', 'raw', 'schedule.json');
    
    // 3. 同步到 MongoDB
    const syncData = require('./syncData');
    const syncSchedule = require('./syncSchedule');
    
    if (await fileExists(overviewPath)) {
      const overviewData = JSON.parse(await fs.readFile(overviewPath, 'utf8'));
      await syncData.syncData(overviewData);
      console.log('[syncKplCrawl] Overview data synced');
    }
    
    if (await fileExists(schedulePath)) {
      const scheduleData = JSON.parse(await fs.readFile(schedulePath, 'utf8'));
      await syncSchedule.syncSchedule(scheduleData);
      console.log('[syncKplCrawl] Schedule data synced');
    }
    
    // 4. 更新最后同步时间戳
    await updateLastSyncTime(KPL_DATA_DIR);
    
    result.synced = true;
    console.log('[syncKplCrawl] Sync completed successfully');
    
  } catch (error) {
    console.error('[syncKplCrawl] Sync failed:', error);
    result.error = error.message;
  }
  
  return result;
}

module.exports = { syncKplCrawl };
