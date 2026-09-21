# DEV.md — 本地开发环境指南

> 适用：cheer-service（Express + MongoDB 单体后端，无构建步骤）。
> 本文档由 v1.1.0 开发期间（2026-09-01）实测整理，所有命令均在本机跑通过。

## 0. 快速总览

```bash
# 一句话启动（首次需先完成 §2 Mongo 初始化）
npm run dev        # node --env-file=.env --watch server/src/app.js，默认 :3000
```

| 依赖    | 版本要求                                    | 说明                                                |
| ------- | ------------------------------------------- | --------------------------------------------------- |
| Node    | ≥ 18（用到 `--env-file`、内置 test runner） |                                                     |
| Docker  | 任意近期版本                                | 只为跑本地 MongoDB                                  |
| MongoDB | 7（与生产 compose 同版本）                  | **必须 replicaSet 模式**（`runTransaction` 用事务） |

## 1. 不需要 MongoDB 也能跑的部分

| 命令                                                                   | 说明                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm test`                                                             | 全部单测走内存 mock DB，178 用例（v1.1.0）直接跑，零配置 |
| `npm run preview:ai-cheer -- --no-data --events-file demo-events.json` | 纯情绪 + 本地事件文件，不连 DB，真实调 AI                |

## 2. MongoDB 初始化（一次性）

**必须用单节点副本集**——standalone 模式不支持事务，额度扣减（`usage_limits`）会报错。

```bash
# 启动容器（mongo:7 与生产 docker-compose.yml 同版本；本地免鉴权）
docker run -d --name cheer-mongo-dev -p 27017:27017 mongo:7 --replSet rs0

# 关键：initiate 时显式指定成员地址为 localhost:27017
docker exec cheer-mongo-dev mongosh --quiet --eval \
  'rs.initiate({_id:"rs0", members:[{_id:0, host:"localhost:27017"}]})'

# 验证（应输出 true）
docker exec cheer-mongo-dev mongosh --quiet --eval 'db.hello().isWritablePrimary'
```

> ⚠️ **坑**：`rs.initiate()` 不带配置时会用容器内部主机名（如 `a9c6effd191d:27017`）注册成员，
> 宿主机的 Node 驱动做副本集发现时解析不了该主机名，报
> `getaddrinfo ENOTFOUND a9c6effd191d`。
> 已中招的修复方式：
>
> ```bash
> docker exec cheer-mongo-dev mongosh --quiet --eval \
>   'rs.reconfig({_id:"rs0", members:[{_id:0, host:"localhost:27017"}]}, {force:true})'
> ```
>
> 副本集配置持久化在数据目录里，容器重启无需重配；只有 `docker rm` 重建才需要重来。

## 3. `.env` 本地化配置

`.env` 已被 `.gitignore` 忽略（第 4 行），本地修改不影响仓库与生产（生产用服务器上自己的 `.env`）。

本地开发建议的最小修改：

```bash
# Mongo 指向本地容器（去掉生产用的账号/authSource）
MONGO_URI=mongodb://localhost:27017/wuyan?replicaSet=rs0

# 关掉容器内调度器，避免本地静默跑 cron（kpl_crawl / cleanup_ai）
SCHEDULER_ENABLED=false
```

其余键（`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `JWT_SECRET` / `APP_USERS` /
`IP_HASH_SALT` / `BLOCKED_TERMS`）保持现状即可；AI 端点走 openai 网关。

> ⚠️ **禁止**把本地开发环境的 `MONGO_URI` 指向生产库（哪怕走 SSH 隧道）——
> dev 写入会污染生产数据（`ai_reports`、额度 `usage_limits`、`app_config`）。
> 只读操作（如跑 `report:cheer-dup` 周报）用隧道可以。

## 4. 启动与验证

```bash
# 全新库先建索引（跑一次即可）
node --env-file=.env scripts/create-indexes.js

# 启动开发服务（--watch 热重载）
npm run dev
# 预期日志：
#   [mongo] connected to mongodb://localhost:27017/wuyan?replicaSet=rs0
#   [server] MongoDB connection established
#   [scheduler] All cron jobs registered
#   [server] Wuyan Cheer API listening on port 3000

# 健康检查
curl http://localhost:3000/api/health
# 预期：{"status":"ok","mongo":"connected",...}
```

## 5. 管理后台与数据

- 后台入口：`http://localhost:3000/api/admin`，账号用 `.env` 里 `APP_USERS`（JSON 数组）中的用户。
- **全新库是空的**：
  - 赛季数据（`season_summaries`）缺失 → 生成自动回退「无可引用数据，纯情绪」模式，功能正常；
    想要带数据的调试，可从生产库**只读导一条** `season_summaries` 文档导入本地。
  - 事件（`cheer_events`）需手动添加：后台「应援文案」面板，或
    `npm run preview:ai-cheer -- --events-file <本地事件 json>`（格式见 `scripts/preview-ai-cheer.js` 头注释）。
- 提示词配置（`app_config/cheer_settings.prompts`）默认回代码默认模板（version 0），后台保存后自增。

## 6. 常用命令速查

| 命令                                                          | 用途                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `npm test`                                                    | 全量单测（mock DB，无需 Mongo）                                |
| `npm run dev`                                                 | 开发服务（--watch，:3000）                                     |
| `npm start`                                                   | 生产方式启动（node --env-file=.env）                           |
| `npm run preview:ai-cheer -- --mode career --date 2026-09-02` | 本地生成预览（连 DB 读事件；`--no-data --events-file` 可离线） |
| `npm run report:cheer-dup`                                    | 重复率量化周报（14/30 天双窗口 Markdown）                      |
| `node --env-file=.env scripts/create-indexes.js`              | 建索引（新库一次）                                             |
| `docker exec cheer-mongo-dev mongosh --quiet`                 | 进本地库手查                                                   |

## 7. 常见错误对照

| 报错                                                                             | 原因                                         | 处理                                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| `getaddrinfo ENOTFOUND <容器id>`                                                 | 副本集成员地址登记成了容器主机名（见 §2 坑） | `rs.reconfig(..., {force:true})` 改为 `localhost:27017` |
| `ECONNREFUSED 127.0.0.1:27017`                                                   | 容器没起 / 端口没映射                        | `docker ps` 查容器；`docker start cheer-mongo-dev`      |
| `MongoServerError: Transaction numbers are only allowed on a replica set member` | Mongo 以 standalone 模式启动                 | 容器必须带 `--replSet rs0` 并 initiate                  |
| 启动卡在 MongoDB connection                                                      | URI 的 replicaSet 参数与实际不符             | 核对 `.env` 的 `MONGO_URI` 与 §2 步骤                   |
