# cheer-service

KPL 选手无言的粉丝应援小程序后端服务，从腾讯云 CloudBase 迁移至 Express + MongoDB。

## 技术栈

- **运行时**: Node.js >= 18（Docker 镜像基于 node:22-alpine）
- **框架**: Express 4
- **数据库**: MongoDB 7+（需副本集以支持事务）
- **AI**: OpenAI 兼容 API（DeepSeek / 其他），支持运行时热切换配置
- **鉴权**: JWT + 旧版 Token 双模式兼容
- **定时任务**: node-cron
- **KPL 数据链路**: 采集/git 备份在宿主机 systemd timer（kpl-data-daily 仓），容器只读挂载数据同步 MongoDB

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
│   │   │   ├── heroes.js           # 英雄数据
│   │   │   ├── cheer.js            # AI 应援文案生成
│   │   │   ├── ask.js              # AI 小秘书问答
│   │   │   ├── checkin.js          # 打卡系统
│   │   │   ├── cron.js             # Vercel Cron 入口（serverless 下的定时任务）
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
│   │       ├── schedules.js        # 任务与 cron 表达式单一数据源
│   │       ├── syncKplCrawl.js     # KPL 数据同步编排（变更检测 → syncData/syncSchedule）
│   │       ├── syncData.js         # 本地数据文件 → MongoDB
│   │       ├── syncSchedule.js     # 本地赛程文件 → MongoDB
│   │       ├── syncScheduleLive.js # 比赛窗口内实时赛程同步
│   │       ├── syncLive.js         # 直播数据同步（⚠️ 已禁用，未注册进调度器，见 docs/kpl-crawl-migration.md 勘误）
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
docker compose up -d --build

# MongoDB 副本集会自动初始化（通过 healthcheck）
# 等待约 30 秒后验证
curl http://localhost:3000/api/health
```

本地构建：`docker compose up -d --build`（强制重建 api 镜像，不使用 `image:` 字段里的远程镜像）。
只拉取已发布镜像时用 `docker compose up -d`：此时从 CNB 制品库拉取 `CHEER_SERVICE_IMAGE`
（默认 `docker.cnb.cool/scriptsmay/cheer-service:latest`），需先 `docker login docker.cnb.cool -u cnb`。

Docker 镜像基于 `node:22-alpine`（纯 Node，无 Python/git）。API 服务映射端口 `19091:3000`。

### 远程一键部署

```bash
# 1. 配置部署信息
cp .env.deploy.example .env.deploy
# 填入 DEPLOY_HOST、DEPLOY_USER、DEPLOY_DIR 等

# 2. 执行部署
./deploy.sh
```

`deploy.sh` 会自动完成：SSH 连通性检查 → 同步 kpl-data-daily 代码 → 打包上传源码 → **在远程服务器本地构建镜像**（`docker compose build api`）→ 切换容器 → 健康检查。

> `deploy.sh` 走的是远程 build 路径，不依赖镜像仓库；`docker-compose.yml` 里 `image:` 只是构建产物的本地标签名。
> 需要按 tag 回滚时在 `.env.deploy` 里设置 `CHEER_SERVICE_IMAGE`（自定义 tag 时请保证远程已存在该镜像）。

### CI 自动部署（main 分支 push）

`.cnb.yml` 的 `deploy` pipeline 与 `deploy.sh` 职责不同，**只做「同步 compose + 换镜像重启容器」**：

1. 自检远端部署目录存在、可写，且已有 `.env`（`.env` 属运行时状态，CI 不覆盖，需人工维护）；
2. 把仓库里的 `docker-compose.yml` 同步到远端 —— 校验含 `CHEER_SERVICE_IMAGE` 且 `docker compose config -q` 通过后，用 `.new` + `mv` 原子替换；
3. 拉取本次构建镜像 `${CNB_DOCKER_REGISTRY}/scriptsmay/cheer-service:${CNB_COMMIT_SHORT}`，以 `CHEER_SERVICE_IMAGE` 显式指定后重启 `api` 容器。

因此**仓库是 `docker-compose.yml` 的唯一事实来源**，改完直接 push 即生效；但以下内容 CI 不会同步，改动了仍需手工 `deploy.sh`：

- `.env`（含 `MONGO_PASSWORD`、密钥等，CI 不碰）
- `logs/` 与 bind mount 数据目录
- 除 `docker-compose.yml` 以外的仓库文件（如 `deploy.sh`、`server/` 源码 —— 镜像已把源码打进去）

同步只覆盖 `docker-compose.yml`，不会波及上述状态文件。

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
| `/api/admin/ai/config` | PUT | JWT | 更新 AI 配置（postgres 模式持久化到 `app_config`，mongo 回退写文件；立即生效） |
| `/api/admin/ai/test` | POST | JWT | 测试 AI 连通性 |
| `/api/admin/sync/status` | GET | JWT | 查询同步状态和选手数据概览 |
| `/api/admin/sync/crawl` | POST | JWT | 手动触发 KPL 数据同步（先应答后执行；同步进行中重复提交回 409） |
| `/api/cron/daily` | GET | `Bearer CRON_SECRET` | Vercel Cron 入口（cleanup_ai + kpl_crawl 合并执行） |

鉴权方式：
- **JWT**: `Authorization: Bearer <token>`
- **Token**: `?token=<AUTH_TOKEN>`（query string，兼容旧版小程序）

## 定时任务

容器内 node-cron 调度（任务清单单一数据源在 `server/src/jobs/schedules.js`，cron 为固定值，不提供后台调整入口）：

| Cron 表达式 | 任务 | 说明 |
|-------------|------|------|
| `0 9 * * *` | kpl_crawl (syncKplCrawl) | 读取采集产物（本地挂载或 GitHub raw），检测变更后触发 syncData + syncSchedule 入库（采集在 kpl-data-daily 宿主机 systemd timer：每日 03:00 全量 / 每 6 小时赛程） |
| `20 3 * * *` | cleanupAiReports | 每日 03:20，清理过期 AI 报告（保留 under_review 状态） |

> Vercel 部署下 `SCHEDULER_ENABLED=false` 关闭容器内调度，两个任务由 Vercel Cron 每日合并触发 `GET /api/cron/daily`。
> `CRAWL_ENABLED=false` 暂停 KPL 数据链路（kpl_crawl 同步任务），清理任务不受影响。
> 采集/赛程节奏在 kpl-data-daily 仓库 `deploy/systemd/` 的 timer 上调整。

## 数据采集架构

```
kpl-data-daily（宿主机 /root/kpl-data-daily，systemd timer）
    │
    ├── 03:00 每日    main.py               # 选手数据采集 + AI 洞察生成
    ├── 00/6 每 6h    fetch-schedule.py     # 赛程采集
    └── 采集后        git-backup.sh         # 数据 git commit & push 备份
    │
    ▼ 只读挂载 /root/kpl-data-daily → /app/kpl-data-daily
    │
    ▼ 容器内 kpl_crawl 任务（每天 09:00，syncKplCrawl 编排）
    │
    ├── 变更检测（github 条件请求 ETag / local 文件 mtime；状态戳存 app_config/kpl_sync_state）
    ├── syncData       # 读取本地 JSON → MongoDB season_summaries
    └── syncSchedule   # 读取本地 JSON → MongoDB match_schedules
```

- 爬虫代码与 unit 文件版本化在 kpl-data-daily 仓库 `deploy/`，通过 `deploy.sh` 或 `git pull` 同步到宿主机
- 容器内无爬虫、无 git；心跳上报由宿主机 `scripts/run-crawl.sh` 完成（UPTIME_PUSH_URL 配在宿主机 .env）

## 管理后台

访问 `/api/admin` 可打开内置管理页面（无需单独部署前端），功能包括：

- **AI 配置管理**：查看/修改 AI Base URL、API Key、Model，修改后立即生效（无需重启容器）
- **AI 连通性测试**：发送测试请求验证 AI 服务可用性
- **数据同步控制**：查看同步状态（最近同步时间/状态/选手概览），手动触发同步（采集节奏由宿主机 systemd timer 管理，后台不提供定时任务调整入口）
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

参见 `.env.example`（Vercel 部署）/ `.env.local.example`（本地部署），关键配置：

| 变量 | 说明 |
|------|------|
| `DB_DRIVER` | 数据后端：`mongo`（默认）\| `postgres` |
| `MONGO_URI` | MongoDB 连接字符串（需包含 `replicaSet=rs0`） |
| `MONGO_PASSWORD` | MongoDB root 密码（Docker 部署用） |
| `POSTGRES_URI` | Postgres 连接串（`DB_DRIVER=postgres` 时必填）。用 session 池化器 5432，不加 `?pgbouncer=true`、不写 `sslmode`（TLS 由代码统一控制） |
| `PG_SCHEMA` | Postgres schema（默认 `cheer`） |
| `PG_POOL_MAX` | 单实例连接池上限（默认 5；serverless 总连接数 ≈ 并发实例数 × 该值） |
| `SCHEDULER_ENABLED` | 进程内调度器开关，`false` 时定时任务改由 `GET /api/cron/daily` 触发（serverless 部署必填 false） |
| `CRON_SECRET` | cron 鉴权密钥，配置后请求须带 `Authorization: Bearer <CRON_SECRET>`；未配置时生产环境拒绝触发 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 跨实例共享限流计数（可选，未配置回退进程内 Map） |
| `CHEER_SERVICE_IMAGE` | api 服务使用的镜像（默认 `docker.cnb.cool/scriptsmay/cheer-service:latest`） |
| `JWT_SECRET` | JWT 签名密钥 |
| `AI_BASE_URL` | OpenAI 兼容 API 地址（默认 DeepSeek） |
| `AI_API_KEY` | AI 服务 API Key |
| `AI_MODEL` | AI 模型名称（默认 `deepseek-v4-flash`） |
| `AUTH_TOKEN` | 旧版 Token 鉴权 |
| `APP_USERS` | JWT 登录用户表（JSON 数组） |
| `ALLOWED_ORIGINS` | CORS 白名单（逗号分隔） |
| `ALLOW_LOCALHOST` | 是否允许 localhost CORS（开发模式） |
| `BLOCKED_TERMS` | 内容安全屏蔽词（逗号分隔） |
| `IP_HASH_SALT` | IP 哈希盐值（限流用） |
| `KPL_SOURCE` | KPL 采集产物数据源：`local`（读挂载目录）\| `github`（读 GitHub raw，默认） |
| `KPL_GITHUB_RAW_BASE` | github 模式 raw 基址（默认指向采集产物仓，末斜杠会被剥离） |
| `KPL_DATA_DIR` | kpl-data-daily 本地数据目录（仅 `KPL_SOURCE=local` 使用，容器内只读挂载） |
| `CRAWL_ENABLED` | KPL 数据链路开关（`false` 暂停同步与实时赛程任务） |
| `AI_USER_DAILY_LIMIT` | AI 应援用户日限额（默认 100） |
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
