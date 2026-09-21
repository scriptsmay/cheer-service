# cheer-service

KPL 选手无言的粉丝应援服务后端（Express API + 内置管理后台），为 Web H5 前端与旧版小程序提供数据与 AI 能力。

## 技术栈

- **运行时**: Node.js >= 18（Docker 镜像基于 `node:22-alpine`；Vercel Function 为 Node 原生运行时）
- **框架**: Express 4（Vercel 下整体包进 catch-all Function）
- **数据库**: 由 `DB_DRIVER` 切换 — `postgres`（Supabase，生产在役）| `mongo`（MongoDB 7 副本集，本地开发与回退链路）
- **AI**: OpenAI 兼容 API（DeepSeek / 其他），支持运行时热切换配置
- **鉴权**: JWT + 旧版 Token 双模式兼容
- **定时任务**: 长驻部署用 node-cron；Vercel 下 `SCHEDULER_ENABLED=false`，由 Vercel Cron 打 `GET /api/cron/daily`
- **KPL 数据链路**: 采集与 git push 在独立宿主（kpl-data-daily，systemd timer）；本服务读其 GitHub 仓库产物入库（`KPL_SOURCE=github`，默认）或本地挂载目录（`local`，回退）
- **限流**: 进程内 Map + 可选 Upstash Redis 跨实例共享计数

## 项目结构

```
cheer-service/
├── api/
│   └── index.js                    # Vercel Function 入口（catch-all 包住 Express app）
├── vercel.json                     # 路由重写 + Vercel Cron 配置
├── server/
│   ├── src/
│   │   ├── app.js                  # Express 入口，整合路由/中间件/定时任务
│   │   ├── config/env.js           # 环境变量集中管理
│   │   ├── db/
│   │   │   ├── index.js            # 按 DB_DRIVER 选择后端的门面
│   │   │   ├── mongo.js            # MongoDB 连接 + TCB SDK 兼容封装层
│   │   │   ├── postgres.js         # Supabase Postgres 同款接口封装（_id + data jsonb）
│   │   │   └── pg-filter.js        # Mongo 查询操作符 → SQL 翻译层
│   │   ├── middleware/             # CORS、限流、鉴权、内容安全
│   │   │   ├── cors.js
│   │   │   ├── rateLimit.js
│   │   │   ├── auth.js
│   │   │   └── contentFilter.js
│   │   ├── routes/                 # 业务路由
│   │   │   ├── auth.js             # JWT 登录（含匿名）
│   │   │   ├── config.js           # 小程序配置
│   │   │   ├── overview.js         # 赛季概览
│   │   │   ├── live.js             # 直播数据
│   │   │   ├── schedule.js         # 赛程数据
│   │   │   ├── heroes.js           # 英雄数据
│   │   │   ├── cheer.js            # AI 应援文案生成（含流式）
│   │   │   ├── ask.js              # AI 小秘书问答
│   │   │   ├── checkin.js          # 打卡系统
│   │   │   ├── cron.js             # Vercel Cron 入口（serverless 下的定时任务）
│   │   │   └── admin.js            # 运维管理 + 数据同步
│   │   ├── services/               # AI、身份、响应封装、AI 配置持久化
│   │   │   ├── ai.js               # OpenAI 兼容 API 封装
│   │   │   ├── ai-config.js        # AI 配置热更新（postgres 模式存 app_config；mongo 模式回退本地文件）
│   │   │   ├── identity.js         # 身份解析（JWT / Token）
│   │   │   └── response.js         # 统一响应封装
│   │   ├── lib/                    # 公共库
│   │   │   ├── ai-utils.js         # 内容安全检查
│   │   │   ├── kpl-source.js       # KPL 产物数据源抽象（github/local 双模式 + ETag）
│   │   │   └── schedule-merge.js   # 赛程合并/窗口计算（多模块共用）
│   │   ├── utils/                  # 工具函数
│   │   │   ├── helpers.js          # hashValue、shanghaiDate、formatRate 等
│   │   │   └── checkin-summary.js  # 打卡摘要计算
│   │   └── jobs/                   # 定时任务调度
│   │       ├── scheduler.js        # cron 调度器（长驻部署）
│   │       ├── schedules.js        # 任务与 cron 表达式单一数据源
│   │       ├── syncKplCrawl.js     # KPL 数据同步编排（变更检测 → syncData/syncSchedule）
│   │       ├── syncData.js         # 采集产物 → 数据库（season_summaries）
│   │       ├── syncSchedule.js     # 采集产物 → 数据库（match_schedules）
│   │       ├── syncScheduleLive.js # （已停注册）比赛窗口实时同步
│   │       ├── syncLive.js         # （已停注册）直播数据同步
│   │       └── cleanupAiReports.js # 过期 AI 报告清理
│   ├── Dockerfile
│   └── tests/                      # 单元测试
├── scripts/
│   ├── migrate-data.js             # TCB 数据导出
│   ├── migrate-mongo-to-pg.js      # Mongo → Postgres 迁移（双端计数 + 抽样对账，支持 --only=）
│   ├── pg-create-schema.js         # Supabase cheer schema 建表
│   ├── create-indexes.js           # MongoDB 索引创建
│   └── preview-ai-cheer.js         # AI 文案预览
├── docs/
│   └── kpl-crawl-migration.md
├── deploy.sh                       # 二级回退通道的远程部署脚本（见「部署与发版」）
├── docker-compose.yml              # MongoDB + API 容器编排（本地/自托管）
├── mongod.cfg                      # 本地 MongoDB 配置
├── .env.example                    # Vercel 部署环境变量模板
├── .env.local.example              # 本地开发环境变量模板
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
   cp .env.local.example .env
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
   # {"status":"ok","version":"x.y.z","db":"connected","driver":"mongo",...}
   ```

### Docker 部署（本地/自托管）

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

## 部署与发版

生产发版通道只有一个：

1. **主通道（Vercel）**：`git push github main` → Vercel 自动构建部署。构建入口 `api/index.js`，路由重写与 Cron 在 `vercel.json`。
2. **二级回退通道（远程 Docker）**：`deploy.sh` 直发自托管服务器，平时待命，仅在需要退回容器形态时启用（见下）。
3. **CNB tag 流水线**：已停用——`.cnb.yml` 的 `tag_push` 构建部署段已整块注释，`main` push 仅跑 install + test。不要向 CNB 推 tag（历史 tag 全部留在 CNB，供版本号计算用；Vercel 只认分支，不读 tag）。

### Vercel 部署

- 环境变量清单以 `.env.example` 为准（模板与 `server/src/config/env.js` 逐项对齐），实际密钥值只维护在 Vercel 项目环境变量中，**不得进仓库**。
- 关键项：`DB_DRIVER=postgres`、`PG_SCHEMA`、`POSTGRES_URI`、`SCHEDULER_ENABLED=false`、`CRON_SECRET`、`ALLOWED_ORIGINS`。漏配 `DB_DRIVER` 会静默回落 mongo 后端（表现为 health `driver: mongo` + `db: disconnected`）。
- `POSTGRES_URI` 两条硬规则：用 session 池化器端口 **5432**（非事务池 6543，`runTransaction` 依赖真事务语义）；**不写 `sslmode`、不带 query 参数**（TLS 由代码统一控制，`sslmode=require` 会被按 verify-full 解析导致握手失败）。
- 环境变量改动**不回填运行中的部署**，改完须 redeploy 才生效。
- Hobby 档 Function 最长 60 秒，AI 长回复贴线；Vercel Cron 只能日级、小时精度（`20 3 * * *` 实际触发窗口 03:20–04:19）。

### 远程一键部署（deploy.sh，二级回退通道）

```bash
# 1. 配置部署信息
cp .env.deploy.example .env.deploy
# 填入 DEPLOY_HOST、DEPLOY_USER、DEPLOY_DIR 等

# 2. 执行部署
./deploy.sh
```

`deploy.sh` 流程：SSH 连通性检查 → （可选）同步 kpl-data-daily 爬虫代码到远程 → 打包上传源码 → **staging 目录内远程构建镜像** → 原子替换正式目录 → 切换容器 → 容器内健康检查，失败自动回滚上一版本镜像并 `exit 1`。

> `deploy.sh` 走远程 build 路径，不依赖镜像仓库；`docker-compose.yml` 里 `image:` 只是构建产物的本地标签名。
> 需要按 tag 回滚时在 `.env.deploy` 里设置 `CHEER_SERVICE_IMAGE`（自定义 tag 时请保证远程已存在该镜像）。

## API 接口

基址以实际部署域名为准（下文路径均相对该基址）。

### 业务接口

| 路径 | 方法 | 鉴权 | 说明 |
|------|------|:----:|------|
| `/api/health` | GET | - | 健康检查，返回 `{status, version, db, driver}`（`driver` 即当前 `DB_DRIVER`，核对配置是否进运行时） |
| `/api/auth/login` | POST | - | JWT 登录，返回 7 天有效 token |
| `/api/config` | GET | Token | 小程序配置（AI 调用限额等） |
| `/api/overview` | GET | Token | 赛季概览（选手信息、生涯/赛季统计、英雄 Top10） |
| `/api/live` | GET | Token | 直播数据（按年月查询，含汇总统计） |
| `/api/schedule` | GET | Token | 赛程数据（含实时窗口状态计算） |
| `/api/heroes` | GET | Token | 英雄数据（胜率、出场数等） |
| `/api/cheer` | POST | JWT | AI 应援文案生成（4 种心情，含数据引用校验；另有 `/api/cheer/stream` 流式） |
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
| `/api/admin/ai/models` | POST | JWT | 拉取可用模型列表（OpenAI 兼容 `/models`） |
| `/api/admin/ai/test` | POST | JWT | 测试 AI 连通性 |
| `/api/admin/cheer/config` | GET/PUT | JWT | 应援文案配置（热更新） |
| `/api/admin/cheer/events`、`/api/admin/cheer/prompts` | GET 等 | JWT | 赛事事件与提示词配置 |
| `/api/admin/sync/status` | GET | JWT | 查询同步状态和选手数据概览 |
| `/api/admin/sync/crawl` | POST | JWT | 手动触发 KPL 数据同步（先应答后执行；同步进行中重复提交回 409） |
| `/api/cron/daily` | GET | `Bearer CRON_SECRET` | Vercel Cron 入口（cleanup_ai + kpl_crawl 合并执行） |

鉴权方式：
- **JWT**: `Authorization: Bearer <token>`
- **Token**: `?token=<AUTH_TOKEN>`（query string，兼容旧版小程序）

## 定时任务

任务清单单一数据源在 `server/src/jobs/schedules.js`（cron 为固定值，不提供后台调整入口）：

| Cron 表达式 | 任务 | 说明 |
|-------------|------|------|
| `0 9 * * *` | kpl_crawl (syncKplCrawl) | 读取采集产物（GitHub raw 或本地挂载），检测变更后触发 syncData + syncSchedule 入库（采集在 kpl-data-daily 宿主 systemd timer：每日 03:00 全量 / 每 6 小时赛程） |
| `20 3 * * *` | cleanupAiReports | 清理过期 AI 报告（保留 under_review 状态） |

> Vercel 部署下 `SCHEDULER_ENABLED=false` 关闭进程内调度，两个任务由 Vercel Cron 每日合并触发 `GET /api/cron/daily`（兼作数据库保活心跳）。
> `CRAWL_ENABLED=false` 暂停 KPL 数据链路（kpl_crawl 同步任务），清理任务不受影响。
> 采集/赛程节奏在 kpl-data-daily 仓 `deploy/systemd/` 的 timer 上调整。

## 数据采集架构

```
kpl-data-daily（独立宿主，systemd timer）
    │
    ├── 03:00 每日    main.py               # 选手数据采集 + AI 洞察生成
    ├── 00/6 每 6h    fetch-schedule.py     # 赛程采集
    └── 采集后        git-backup.sh         # 数据 git commit & push 备份
    │
    ▼ 本服务读取采集产物（server/src/lib/kpl-source.js）
    │   ├── KPL_SOURCE=github（默认）：读 GitHub raw + 条件请求（ETag → 304）
    │   └── KPL_SOURCE=local：读挂载/本地目录（回退模式）
    ▼ kpl_crawl 任务（syncKplCrawl 编排）
    │
    ├── 变更检测（build_id / updated_at 比对；状态戳存 app_config/kpl_sync_state，与数据同库）
    ├── syncData       # 产物 JSON → season_summaries
    └── syncSchedule   # 产物 JSON → match_schedules
```

- 爬虫代码与 unit 文件版本化在 kpl-data-daily 仓 `deploy/`；本服务不参与采集执行
- 容器内无爬虫、无 git；心跳上报由采集宿主侧完成（`UPTIME_PUSH_URL` 配在采集宿主 .env）

## 管理后台

访问 `/api/admin` 可打开内置管理页面（无需单独部署前端），功能包括：

- **AI 配置管理**：查看/修改 AI Base URL、API Key、Model，修改后立即生效（无需重启）
- **AI 连通性测试**：发送测试请求验证 AI 服务可用性
- **应援文案配置**：文案多样性/赛事事件/提示词配置（热更新）
- **数据同步控制**：查看同步状态（最近同步时间/状态/选手概览），手动触发同步（采集节奏由 kpl-data-daily 宿主 timer 管理，后台不提供定时任务调整入口）
- 配置存储优先级：`app_config` 表（postgres 模式，管理页面写入处）> 环境变量；mongo 模式下回退本地文件 `/app/data/ai-config.json`

## 测试

```bash
npm test
```

测试覆盖：工具函数、打卡摘要、内容安全过滤、pg 查询翻译层（pg-filter 纯函数）、DB 适配器契约、AI 配置链路回归等（`node --test`，255 用例）。

## 环境变量

模板见 `.env.example`（Vercel 部署）与 `.env.local.example`（本地部署），集中定义在 `server/src/config/env.js`（少数变量在模块内直读，如 `AI_THINKING_BUDGET`、`AI_*_DAILY_LIMIT`）。关键配置：

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
| `AI_MODEL` | AI 模型名称（默认 `deepseek-v4-flash`；运行时可由管理后台 AI 配置热切换） |
| `AUTH_TOKEN` | 旧版 Token 鉴权 |
| `APP_USERS` | JWT 登录用户表（JSON 数组） |
| `ALLOWED_ORIGINS` | CORS 白名单（逗号分隔） |
| `ALLOW_LOCALHOST` | 是否允许 localhost CORS（开发模式） |
| `BLOCKED_TERMS` | 内容安全屏蔽词（逗号分隔） |
| `IP_HASH_SALT` | IP 哈希盐值（限流用） |
| `KPL_SOURCE` | KPL 采集产物数据源：`github`（读 GitHub raw，默认）\| `local`（读挂载目录，回退） |
| `KPL_GITHUB_RAW_BASE` | github 模式 raw 基址（默认指向采集产物仓，末斜杠会被剥离） |
| `KPL_DATA_DIR` | 仅 `KPL_SOURCE=local` 使用的数据目录 |
| `CRAWL_ENABLED` | KPL 数据链路开关（`false` 暂停同步任务） |
| `AI_USER_DAILY_LIMIT` | AI 应援用户日限额（默认 100） |
| `AI_IP_DAILY_LIMIT` | AI 应援 IP 日限额（默认 30） |
| `AI_GLOBAL_DAILY_LIMIT` | AI 应援全局日限额（默认 500） |

> 已移除的历史变量：`SYNC_API_KEY`、`GITHUB_TOKEN`、`GITHUB_REPO`（随采集与业务分离改造删除）；`KPL_SYNC_STATE_FILE`（同步状态戳迁入 `app_config` 后不再使用）。

## 迁移说明

本项目从腾讯云 CloudBase 迁移而来，其后数据库与宿主再迁 Vercel + Supabase：

| CloudBase | 迁移后 |
|-----------|--------|
| `@cloudbase/node-sdk` | DB 门面（mongo.js / postgres.js 同款 TCB SDK 兼容封装层） |
| `app.ai().createModel()` | OpenAI 兼容 API + 运行时热切换 |
| CloudBase Auth | JWT 本地签发 + 旧版 Token 兼容 |
| 15 个云函数 | Express 单体路由 |
| TCB 定时触发器 | node-cron / Vercel Cron（`/api/cron/daily`） |
| CloudBase 数据库 | Postgres（Supabase，`cheer` schema jsonb 文档表）；MongoDB 为回退链路 |
| GH Actions 采集 | 独立宿主 systemd timer + GitHub 产物仓（本服务只读产物） |
| 无管理界面 | 内置管理后台（AI 配置 + 文案配置 + 同步控制） |

## License

Private
