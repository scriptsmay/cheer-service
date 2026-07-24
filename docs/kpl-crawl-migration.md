# KPL 数据采集迁移方案

> 将 kpl-data-daily 的 GitHub Actions 定时采集迁移到 cheer-service Docker 容器内执行，消除外部调度依赖不稳定问题。

## 背景

kpl-data-daily 当前通过 GitHub Actions `daily-fetch.yml` cron (`16 1 * * *` UTC) 定时执行 Python 爬虫采集数据。GH Actions 定时触发不可靠（可能延迟数小时或跳过），导致数据更新不稳定。

cheer-service 已有 node-cron 定时基础设施（部署在腾讯云 Docker），且 `syncScheduleLive` 已在直接调用 KPL API，具备接管采集的条件。

## 架构变化

```
迁移前:
  GH Actions (UTC 01:16, 不稳定)
    ├── python main.py          → git → cal.kplwuyan.site (静态站点)
    ├── python fetch-schedule.py
    └── HTTP POST              → cheer-service /api/admin/sync/*
  cheer-service cron
    ├── 04:00 HTTP fetch        ← cal.kplwuyan.site → MongoDB
    └── 06:00 HTTP fetch        ← cal.kplwuyan.site → MongoDB

迁移后:
  cheer-service cron (node-cron, 可靠)
    ├── 03:00 python main.py         ← 容器内本地执行
    ├── 03:30 python fetch-schedule.py
    ├── 04:00 fs.readFileSync        ← 本地读文件 → MongoDB
    └── 06:00 fs.readFileSync        ← 本地读文件 → MongoDB
  GH Actions
    └── 仅 workflow_dispatch 手动触发 → 备份/历史补齐
```

## 改动清单

### 1. Dockerfile — 添加 Python 3 运行时

**文件**: `server/Dockerfile`

基础镜像 `node:22-alpine`，通过 apk 装 Python 和依赖。三个 Python 包（requests, openai, python-dotenv）均为纯 Python，无需 C 编译器。

```dockerfile
FROM node:22-alpine

# 新增: Python 3 + pip
RUN apk add --no-cache python3 py3-pip

WORKDIR /app

COPY package.json ./
RUN npm install --production

# 新增: 安装 Python 依赖
COPY kpl-requirements.txt ./
RUN pip3 install --break-system-packages -r kpl-requirements.txt

COPY server/src/ ./server/src/

EXPOSE 3000

CMD ["node", "server/src/app.js"]
```

**新增文件** `kpl-requirements.txt`:
```
requests>=2.31.0
openai>=1.0.0
python-dotenv>=1.0.0
```

### 2. docker-compose.yml — 挂载 kpl-data-daily 并传递环境变量

**文件**: `docker-compose.yml`

```yaml
api:
  volumes:
    - /root/kpl-data-daily:/app/kpl-data-daily   # 新增: kpl-data-daily 代码+数据
    - api-data:/app/data                           # 已有
  environment:
    # 已有
    - MONGO_URI=...
    - TZ=Asia/Shanghai
    - SYNC_API_KEY=${SYNC_API_KEY:-}
    # 新增: KPL 数据目录 & Python AI 配置（从 cheer-service AI 配置透传）
    - KPL_DATA_DIR=/app/kpl-data-daily
    - OPENAI_API_KEY=${AI_API_KEY:-}
    - OPENAI_BASE_URL=${AI_BASE_URL:-https://api.deepseek.com/v1}
    - OPENAI_MODEL=${AI_MODEL:-deepseek-chat}
```

kpl-data-daily 输出到自身的 `data/` 目录，通过 volume mount 持久化在宿主机，容器重启不丢失。

### 3. 新增 syncKplCrawl.js — 定时采集 Job

**新文件**: `server/src/jobs/syncKplCrawl.js`

核心逻辑：通过 `child_process.spawn` 执行 Python 脚本，采集完成后返回结果。

```javascript
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const KPL_DIR = process.env.KPL_DATA_DIR || '/app/kpl-data-daily';

/**
 * 执行 Python 脚本并返回结果
 */
function runPython(script, args = []) {
  return new Promise((resolve, reject) => {
    const cwd = KPL_DIR;
    const cmd = 'python3';
    const fullArgs = [script, ...args];
    
    console.log(`[kpl-crawl] Running: ${cmd} ${fullArgs.join(' ')} (cwd: ${cwd})`);
    const t0 = Date.now();

    const proc = spawn(cmd, fullArgs, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    
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
 * 主采集任务 — 替代 GH Actions daily-fetch
 * 1. python main.py          (数据采集 + 后处理)
 * 2. python fetch-schedule.py (赛程采集)
 */
async function syncKplCrawl() {
  const results = { main: null, schedule: null };

  try {
    results.main = await runPython('main.py');
  } catch (e) {
    console.error('[kpl-crawl] main.py error:', e.message);
  }

  try {
    results.schedule = await runPython('scripts/fetch-schedule.py');
  } catch (e) {
    console.error('[kpl-crawl] fetch-schedule.py error:', e.message);
  }

  return results;
}

module.exports = { syncKplCrawl, runPython };
```

### 4. 改造 syncData.js — HTTP fetch → 本地文件读取

**文件**: `server/src/jobs/syncData.js`

改动点：`fetchData()` 函数从 HTTP fetch 改为 `fs.readFileSync`，路径指向挂载的 kpl-data-daily 数据目录。

```javascript
// 替换原有的 fetchData 函数
const fs = require('fs');
const path = require('path');

const KPL_DATA_DIR = process.env.KPL_DATA_DIR || '/app/kpl-data-daily';

function fetchData(relPath) {
  const fullPath = path.join(KPL_DATA_DIR, relPath);
  console.log(`[sync] Reading: ${fullPath}`);
  try {
    return fs.readFileSync(fullPath, 'utf-8');
  } catch (e) {
    console.error(`[sync] Read failed: ${fullPath} - ${e.message}`);
    return null;
  }
}
```

同时更新 sync snapshot 的 `source` 字段：
```javascript
source: `local:${path}`
```

### 5. 改造 syncSchedule.js — HTTP fetch → 本地文件读取

**文件**: `server/src/jobs/syncSchedule.js`

同 syncData.js，将 `fetchData()` 改为本地文件读取。

### 6. scheduler.js — 新增 cron 条目

**文件**: `server/src/jobs/scheduler.js`

新增 `syncKplCrawl` 导入和 cron 条目：

```javascript
const { syncKplCrawl } = require('./syncKplCrawl');

// 新增: KPL 数据采集 (替代 GH Actions)
// 03:00 执行 main.py (爬虫 + 后处理, 约 5-10 分钟)
cron.schedule('0 3 * * *', async () => {
  console.log('[scheduler] Running syncKplCrawl at 03:00');
  try { await syncKplCrawl(); } catch (e) { console.error('[scheduler] syncKplCrawl error:', e.message); }
});

// ... 原有 cron 保持不变
```

时间线设计：
```
03:00  syncKplCrawl    ← python main.py + fetch-schedule.py
04:00  syncData        ← 读本地文件入库 (原 HTTP 拉取)
05:00  syncLive        ← 不变
06:00  syncSchedule    ← 读本地文件入库 (原 HTTP 拉取)
```

### 7. admin.js — 新增手动触发接口

**文件**: `server/src/routes/admin.js`

新增 `POST /api/admin/sync/crawl` 接口（需登录鉴权），用于手动触发 KPL 数据采集。

```javascript
// 导入 crawl job
let syncKplCrawl;
try { syncKplCrawl = require('../jobs/syncKplCrawl').syncKplCrawl; } catch (_) {}

// POST /api/admin/sync/crawl — 手动触发数据采集 [需登录]
router.post('/sync/crawl', requireAuth, async (req, res) => {
  if (!syncKplCrawl) {
    return res.status(500).json({ ok: false, error: 'syncKplCrawl module not loaded' });
  }
  
  console.log('[admin] Manual crawl triggered');
  
  // 异步执行，立即返回确认
  res.json({ ok: true, message: '数据采集已触发，请查看日志' });
  
  try {
    const result = await syncKplCrawl();
    console.log('[admin] Manual crawl completed:', JSON.stringify(result));
  } catch (e) {
    console.error('[admin] Manual crawl failed:', e.message);
  }
});
```

**接口说明**:
| 项目 | 值 |
|---|---|
| 方法 | POST |
| 路径 | `/api/admin/sync/crawl` |
| 鉴权 | 需登录（Bearer Token） |
| 请求体 | 无 |
| 响应 | `{ ok: true, message: "数据采集已触发，请查看日志" }` |
| 说明 | 异步执行，立即返回。执行日志输出到容器 stdout |

该接口也可添加到 admin 管理页面 HTML 中，提供一个「手动采集」按钮方便运维。

### 8. deploy.sh — 同步调整

**文件**: `deploy.sh`

改动点：
1. `tar` 打包新增包含 `kpl-requirements.txt`
2. 新增 kpl-data-daily 部署步骤：将本地 kpl-data-daily 代码 rsync/scp 到远程 `/root/kpl-data-daily`

```bash
# ── 2.5. 部署 kpl-data-daily ──
log "部署 kpl-data-daily 到远程..."
# 远程首次部署: 创建目录
ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "mkdir -p /root/kpl-data-daily"
# 同步代码 (排除 data/ 内的历史文件节省传输)
rsync -avz -e "ssh -p $DEPLOY_PORT" \
  --exclude='data/*.json' \
  --exclude='.git' \
  --exclude='__pycache__' \
  --exclude='.venv' \
  "$KPL_SOURCE_DIR/" "${DEPLOY_USER}@${DEPLOY_HOST}:/root/kpl-data-daily/"
```

`KPL_SOURCE_DIR` 从 `.env.deploy` 读取，默认 `../kpl-data-daily`。

### 9. GitHub Actions — 停用定时

**文件**: `.github/workflows/daily-fetch.yml`

将 `schedule` 部分注释掉，保留 `workflow_dispatch`：

```yaml
on:
  # 定时采集已迁移至 cheer-service Docker 容器，此处仅保留手动触发做备份
  # schedule:
  #   - cron: '16 1 * * *'
  workflow_dispatch:
    # ... 不变
```

### 10. 环境变量汇总

**需新增的环境变量**（在 `.env` / `.env.example` 中）:

| 变量 | 说明 | 默认值 |
|---|---|---|
| `KPL_DATA_DIR` | kpl-data-daily 挂载路径 | `/app/kpl-data-daily` |
| `OPENAI_API_KEY` | Python AI 分析用（透传 cheer-service 的 `AI_API_KEY`） | `-` |
| `OPENAI_BASE_URL` | Python AI 分析用（透传 cheer-service 的 `AI_BASE_URL`） | `-` |
| `OPENAI_MODEL` | Python AI 分析用（透传 cheer-service 的 `AI_MODEL`） | `-` |

docker-compose 中已将 cheer-service 的 AI 变量映射透传给 Python 脚本（见第 2 步）。

## 部署步骤

### 首次部署

```bash
# 1. 在远程服务器创建 kpl-data-daily 目录并上传代码
ssh root@your-server "mkdir -p /root/kpl-data-daily"
rsync -avz --exclude='.git' --exclude='__pycache__' \
  ../kpl-data-daily/ root@your-server:/root/kpl-data-daily/

# 2. 部署 cheer-service（含 Dockerfile 变更）
cd cheer-service
./deploy.sh

# 3. 验证
ssh root@your-server "docker compose -f /root/cheer-service/docker-compose.yml logs -f api"
```

### 手动触发测试

```bash
# 通过 API 手动触发一次采集
curl -X POST https://your-api-domain/api/admin/sync/crawl \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## 回滚方案

如新方案有问题，可快速切回 GitHub Actions：

1. 取消注释 `daily-fetch.yml` 中的 cron 配置
2. 注释 cheer-service `scheduler.js` 中的 `syncKplCrawl` cron 条目
3. cheer-service 的 `syncData`/`syncSchedule` 保持原 HTTP fetch 逻辑不变

两个方案可并行运行，不会冲突（MongoDB upsert 是幂等的）。

## 文件变更总览

| 文件 | 操作 | 说明 |
|---|---|---|
| `server/Dockerfile` | 修改 | 添加 Python 3 + pip + 依赖安装 |
| `kpl-requirements.txt` | **新增** | Python 依赖清单 |
| `docker-compose.yml` | 修改 | 挂载 kpl-data-daily 目录 + 环境变量 |
| `server/src/jobs/syncKplCrawl.js` | **新增** | Python 采集调度 Job |
| `server/src/jobs/syncData.js` | 修改 | HTTP fetch → 本地文件读取 |
| `server/src/jobs/syncSchedule.js` | 修改 | HTTP fetch → 本地文件读取 |
| `server/src/jobs/scheduler.js` | 修改 | 新增 cron 条目 |
| `server/src/routes/admin.js` | 修改 | 新增 POST /api/admin/sync/crawl |
| `server/src/config/env.js` | 修改 | 新增 KPL_DATA_DIR 配置 |
| `.env.example` | 修改 | 新增环境变量说明 |
| `deploy.sh` | 修改 | 新增 kpl-data-daily 部署步骤 |
| `.env.deploy.example` | 修改 | 新增 KPL_SOURCE_DIR 配置 |
| `.github/workflows/daily-fetch.yml` | 修改 | 注释 cron，保留手动触发 |
