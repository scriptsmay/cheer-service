# cheer-service

KPL 选手无言的粉丝应援小程序后端服务，从腾讯云 CloudBase 迁移至 Express + MongoDB。

## 技术栈

- **运行时**: Node.js >= 18（Docker 镜像基于 node:22-alpine）
- **框架**: Express 4
- **数据库**: MongoDB 7+（需副本集以支持事务）
- **AI**: OpenAI 兼容 API（DeepSeek / 其他），支持运行时热切换配置
- **鉴权**: JWT + 旧版 Token 双模式兼容
- **定时任务**: node-cron
- **数据采集**: 容器内 Python 爬虫（kpl-data-daily），采集后自动 git push 备份

## 项目结构

```
cheer-service/
├── server/
│   ├── src/
│   │   ├── app.js                  # Express 入口，整合路由/中间件/定时任务
│   │   ├── config/env.js           # 环境变量集中管理
│   │   ├── db/mongo.js             # MongoDB 连接 + TCB SDK 兼容封装层
│   │   ├── middleware/             # CORS、限流、鉴权、内容安全
│   │   │   ├── cors.js
│   │   │   ├── rateLimit.js
│   │   │   ├── auth.js
│   │   │   └── contentFilter.js
│   │   ├── routes/                 # 11 个业务路由
│   │   │   ├── auth.js             # JWT 登录
│   │   │   ├── config.js           # 小程序配置
│   │   │   ├── overview.js         # 赛季概览
│   │   │   ├── live.js             # 直播数据
│   │   │   ├── schedule.js         # 赛程数据
│   │   │   ├── story.js            # 周报故事卡
│   │   │   ├── heroes.js           # 英雄数据
│   │   │   ├── cheer.js            # AI 应援文案生成
│   │   │   ├── ask.js              # AI 小秘书问答
│   │   │   ├── checkin.js          # 打卡系统
│   │   │   └── admin.js            # 运维管理 + 数据同步
│   │   ├── services/               # AI、身份、响应封装、AI 配置持久化
│   │   │   ├── ai.js               # OpenAI 兼容 API 封装
│   │   │   ├── ai-config.js        # AI 配置热更新（文件 > 环境变量）
│   │   │   ├── identity.js         # 身份解析（JWT / Token）
│   │   │   └── response.js         # 统一响应封装
│   │   ├── lib/                    # 公共库
│   │   │   ├── ai-utils.js         # 内容安全检查
│   │   │   └── schedule-merge.js   # 赛程合并/窗口计算（多模块共用）
│   │   ├── utils/                  # 工具函数
│   │   │   ├── helpers.js          # hashValue、shanghaiDate、formatRate 等
│   │   │   └── checkin-summary.js  # 打卡摘要计算
│   │   └── jobs/                   # 定时任务调度
│   │       ├── scheduler.js        # cron 调度器
│   │       ├── syncKplCrawl.js     # Python 爬虫采集 + git push 备份
│   │       ├── syncData.js         # 本地数据文件 → MongoDB
│   │       ├── syncSchedule.js     # 本地赛程文件 → MongoDB
│   │       ├── syncScheduleLive.js # 比赛窗口内实时赛程同步
│   │       ├── syncLive.js         # 直播数据同步
│   │       ├── weeklyStory.js      # AI 周故事卡生成
│   │       └── cleanupAiReports.js # 过期 AI 报告清理
│   ├── Dockerfile
│   └── tests/                      # 单元测试
├── scripts/                        # 迁移、索引、预览脚本
│   ├── migrate-data.js
│   ├── create-indexes.js
│   └── preview-ai-cheer.js
├── docs/
│   └── kpl-crawl-migration.md
├── deploy.sh                       # 一键远程部署脚本
├── docker-compose.yml              # MongoDB + API 容器编排
├── kpl-requirements.txt            # Python 爬虫依赖
├── mongod.cfg                      # 本地 MongoDB 配置
├── .env.example
└── package.json
```

## 快速开始

### 本地开发

1. **安装 MongoDB**

   ```bash
   # macOS (Homebrew)
   brew tap mongodb/brew
   brew install mongodb-community
   ```

   启动 MongoDB 并初始化副本集：

   ```bash
   mongod --dbpath ./data/mongodb --port 27017 --bind_ip 127.0.0.1 --replSet rs0
   # 另一个终端
   mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
   ```

2. **配置环境变量**

   ```bash
   cp .env.example .env
   # 编辑 .env，填入实际的 MongoDB URI、AI API Key 等
   ```

3. **安装依赖并启动**

   ```bash
   npm install
   npm run dev    # 开发模式（文件变更自动重启）
   # 或
   npm start      # 生产模式
   ```

4. **验证**

   ```bash
   curl http://localhost:3000/api/health
   # {"status":"ok","mongo":"connected",...}
   ```

### Docker 部署

```bash
# 设置密码
export MONGO_PASSWORD=your_secure_password

# 构建并启动
docker compose up -d

# MongoDB 副本集会自动初始化（通过 healthcheck）
# 等待约 30 秒后验证
curl http://localhost:3000/api/health
```

Docker 镜像基于 `node:22-alpine`，内置 Python 3 + git，支持容器内直接运行 kpl-data-daily 爬虫。API 服务映射端口 `19091:3000`。

### 远程一键部署

```bash
# 1. 配置部署信息
cp .env.deploy.example .env.deploy
# 填入 DEPLOY_HOST、DEPLOY_USER、DEPLOY_DIR 等

# 2. 执行部署
./deploy.sh
```

`deploy.sh` 会自动完成：SSH 连通性检查 → 同步 kpl-data-daily 代码 → 打包上传源码 → 远程重建容器 → 健康检查。

## API 接口

### 业务接口

| 路径 | 方法 | 鉴权 | 说明 |
|------|------|:----:|------|
| `/api/health` | GET | - | 健康检查（含 MongoDB 连通状态） |
| `/api/auth/login` | POST | - | JWT 登录，返回 7 天有效 token |
| `/api/config` | GET | Token | 小程序配置（AI 调用限额等） |
| `/api/overview` | GET | Token | 赛季概览（选手信息、生涯/赛季统计、英雄 Top10） |
| `/api/live` | GET | Token | 直播数据（按年月查询，含汇总统计） |
| `/api/schedule` | GET | Token | 赛程数据（含实时窗口状态计算） |
| `/api/story` | GET | Token | 周报故事卡（AI 生成，含周环比数据） |
| `/api/heroes` | GET | Token | 英雄数据（胜率、出场数等） |
| `/api/cheer` | POST | JWT | AI 应援文案生成（4 种心情，含数据引用校验） |
| `/api/ask` | POST | JWT | AI 小秘书问答（基于赛季/直播/赛程数据） |
| `/api/checkins` | POST | JWT | 打卡（事务 + 限流 + 幂等） |
| `/api/checkins/me` | GET | JWT | 当前用户打卡摘要（连续天数、总天数） |
| `/api/checkins/me/report` | GET | JWT | 今日加油卡 AI 报告 |
| `/api/checkins/stats` | GET | - | 当日全局打卡统计 |

### 运维管理接口

| 路径 | 方法 | 鉴权 | 说明 |
|------|------|:----:|------|
| `/api/admin` | GET | - | 管理页面（内联 HTML，含登录表单） |
| `/api/admin/ai/config` | GET | JWT | 查看当前 AI 配置（脱敏） |
| `/api/admin/ai/config` | PUT | JWT | 更新 AI 配置（持久化到文件，立即生效） |
| `/api/admin/ai/test` | POST | JWT | 测试 AI 连通性 |
| `/api/admin/sync/status` | GET | JWT | 查询采集状态和选手数据概览 |
| `/api/admin/sync/crawl` | POST | JWT | 手动触发 KPL 数据采集 |
| `/api/admin/sync/overview` | POST | API Key | 接收赛季概览数据（kpl-data-daily 推送） |
| `/api/admin/sync/schedule` | POST | API Key | 接收赛程数据（kpl-data-daily 推送） |

鉴权方式：
- **JWT**: `Authorization: Bearer <token>`
- **Token**: `?token=<AUTH_TOKEN>`（query string，兼容旧版小程序）
- **API Key**: `X-Sync-Key: <SYNC_API_KEY>`（header，数据同步专用）

## 定时任务

| Cron 表达式 | 任务 | 说明 |
|-------------|------|------|
| `0 3,9,15,21 * * *` | syncKplCrawl | Python 爬虫采集（main.py + fetch-schedule.py），6 小时一次。采集前 git pull 同步代码，采集后检测数据变更，有变更才触发 syncData + syncSchedule 入库，最后 git push 备份 |
| `*/10 * * * *` | syncScheduleLive | 实时赛程同步，仅比赛窗口内激活（调用 KPL 官方 API） |
| `0 5 * * 1` | weeklyStory | 每周一 05:00，AI 生成周故事卡（基于周环比快照） |
| `20 3 * * *` | cleanupAiReports | 每日 03:20，清理过期 AI 报告（保留 under_review 状态） |

> `CRAWL_ENABLED=false` 可暂停所有调用第三方 API 的采集任务（syncKplCrawl、syncScheduleLive），不影响读本地文件的 syncData/syncSchedule。

## 数据采集架构

```
kpl-data-daily (Python 爬虫)
    │
    ├── main.py              # 选手数据采集 + AI 洞察生成
    ├── scripts/fetch-schedule.py  # 赛程采集
    │
    ▼ 容器内本地执行 (syncKplCrawl)
    │
    ├── git pull rebase      # 采集前同步最新爬虫代码
    ├── python main.py       # 数据采集
    ├── python fetch-schedule.py
    ├── git diff 检测变更     # 排除时间戳和 AI 生成文件的误判
    ├── git push (SSH)       # 采集后自动备份到 GitHub
    │
    ▼ 有数据变更时触发
    │
    ├── syncData             # 读取本地 JSON → MongoDB season_summaries
    └── syncSchedule         # 读取本地 JSON → MongoDB match_schedules
```

- 爬虫代码挂载在容器内 `/app/kpl-data-daily`，通过 `deploy.sh` 同步
- git push 默认走 SSH（挂载宿主机 deploy key），可回退 HTTPS + token 模式
- 支持采集前 `git fetch + rebase` 对齐远程，采集后 push 带重试（国内网络抖动）

## 管理后台

访问 `/api/admin` 可打开内置管理页面（无需单独部署前端），功能包括：

- **AI 配置管理**：查看/修改 AI Base URL、API Key、Model，修改后立即生效（无需重启容器）
- **AI 连通性测试**：发送测试请求验证 AI 服务可用性
- **数据采集控制**：查看采集状态（最近同步时间/状态/选手概览），手动触发采集
- 配置优先级：`/app/data/ai-config.json`（管理页面修改）> 环境变量（docker-compose 默认值）

## 测试

```bash
npm test
```

测试覆盖：
- 工具函数（hashValue、shanghaiDate、formatRate 等）
- 打卡摘要计算（streak、去重、日期校验）
- 内容安全过滤
- 事务封装返回值传播（验证 `runTransaction` 正确返回回调结果）

## 环境变量

参见 `.env.example`，关键配置：

| 变量 | 说明 |
|------|------|
| `MONGO_URI` | MongoDB 连接字符串（需包含 `replicaSet=rs0`） |
| `MONGO_PASSWORD` | MongoDB root 密码（Docker 部署用） |
| `JWT_SECRET` | JWT 签名密钥 |
| `AI_BASE_URL` | OpenAI 兼容 API 地址（默认 DeepSeek） |
| `AI_API_KEY` | AI 服务 API Key |
| `AI_MODEL` | AI 模型名称（默认 `deepseek-chat`） |
| `AUTH_TOKEN` | 旧版 Token 鉴权 |
| `APP_USERS` | JWT 登录用户表（JSON 数组） |
| `ALLOWED_ORIGINS` | CORS 白名单（逗号分隔） |
| `ALLOW_LOCALHOST` | 是否允许 localhost CORS（开发模式） |
| `BLOCKED_TERMS` | 内容安全屏蔽词（逗号分隔） |
| `IP_HASH_SALT` | IP 哈希盐值（限流用） |
| `SYNC_API_KEY` | 数据同步 API Key（push 模式鉴权） |
| `KPL_DATA_DIR` | kpl-data-daily 本地数据目录（容器内路径） |
| `CRAWL_ENABLED` | 第三方采集开关（`false` 暂停） |
| `GITHUB_REPO` | kpl-data-daily GitHub 仓库（采集后 git push 备份） |
| `GITHUB_TOKEN` | GitHub PAT（仅 HTTPS 模式需要，SSH 模式忽略） |
| `GITHUB_PUSH_SSH` | git push 认证方式（默认 `true` SSH） |
| `GIT_USER_NAME` | git commit 作者名 |
| `GIT_USER_EMAIL` | git commit 邮箱 |
| `AI_USER_DAILY_LIMIT` | AI 应援用户日限额（默认 10） |
| `AI_IP_DAILY_LIMIT` | AI 应援 IP 日限额（默认 30） |
| `AI_GLOBAL_DAILY_LIMIT` | AI 应援全局日限额（默认 500） |

## 迁移说明

本项目从腾讯云 CloudBase 迁移而来，主要变更：

| CloudBase | 迁移后 |
|-----------|--------|
| `@cloudbase/node-sdk` | MongoDB Driver + TCB SDK 兼容封装层 |
| `app.ai().createModel()` | OpenAI 兼容 API + 运行时热切换 |
| CloudBase Auth | JWT 本地签发 + 旧版 Token 兼容 |
| 15 个云函数 | Express 单体路由（11 个路由模块） |
| TCB 定时触发器 | node-cron |
| CloudBase 数据库 | MongoDB 副本集（支持事务） |
| GH Actions 采集 | 容器内 Python 爬虫 + 定时任务 |
| 无管理界面 | 内置管理后台（AI 配置 + 采集控制） |

## License

Private
