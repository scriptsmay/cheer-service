# cheer-service

KPL 选手无言的粉丝应援小程序后端服务，从腾讯云 CloudBase 迁移至 Express + MongoDB。

## 技术栈

- **运行时**: Node.js >= 18
- **框架**: Express 4
- **数据库**: MongoDB 7+（需副本集以支持事务）
- **AI**: OpenAI 兼容 API（DeepSeek / 其他）
- **鉴权**: JWT + 旧版 Token 双模式兼容
- **定时任务**: node-cron

## 项目结构

```
cheer-service/
├── server/
│   ├── src/
│   │   ├── app.js              # Express 入口
│   │   ├── config/env.js       # 环境变量集中管理
│   │   ├── db/mongo.js         # MongoDB 连接 + TCB SDK 兼容封装
│   │   ├── middleware/         # CORS、限流、鉴权、内容安全
│   │   ├── routes/             # 10 个业务路由
│   │   ├── services/           # AI、身份、响应封装
│   │   ├── lib/                # ai-utils 等公共库
│   │   ├── utils/              # helpers、checkin-summary
│   │   └── jobs/               # 定时任务调度
│   ├── Dockerfile
│   └── tests/                  # 单元测试
├── scripts/                    # 迁移、索引脚本
├── data/                       # MongoDB 数据目录 + 导出文件
├── docker-compose.yml
├── .env.example
└── package.json
```

## 快速开始

### 本地开发

1. **安装 MongoDB**

   ```bash
   # Windows (winget)
   winget install MongoDB.Server
   winget install MongoDB.Shell
   winget install MongoDB.DatabaseTools
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

## API 接口

| 路径 | 方法 | 鉴权 | 说明 |
|------|------|:----:|------|
| `/api/health` | GET | - | 健康检查 |
| `/api/auth/login` | POST | - | JWT 登录 |
| `/api/config` | GET | Token | 小程序配置 |
| `/api/overview` | GET | Token | 赛季概览 |
| `/api/live` | GET | Token | 直播数据 |
| `/api/schedule` | GET | Token | 赛程数据 |
| `/api/story` | GET | Token | 周报故事 |
| `/api/heroes` | GET | Token | 英雄数据 |
| `/api/cheer` | POST | JWT | AI 应援文案生成 |
| `/api/ask` | POST | JWT | AI 小秘书问答 |
| `/api/checkins` | POST | JWT | 打卡 |
| `/api/checkins/me` | GET | JWT | 打卡摘要 |
| `/api/checkins/stats` | GET | - | 全局打卡统计 |

鉴权方式：
- **JWT**: `Authorization: Bearer <token>`
- **Token**: `?token=<AUTH_TOKEN>` (query string)

## 数据迁移

从 CloudBase 导出数据到本地 MongoDB：

```bash
# 1. 在 wuyan-cloudbase 项目中运行导出脚本
cd ../wuyan-cloudbase
node --env-file=.env scripts/export-all-data.js

# 2. 导入到本地 MongoDB
cd ../cheer-service
bash data/export/import.sh "mongodb://127.0.0.1:27017/wuyan?replicaSet=rs0"

# 3. 创建索引
node scripts/create-indexes.js
```

## 测试

```bash
npm test
```

测试覆盖：
- 工具函数（hashValue、shanghaiDate、formatRate 等）
- 打卡摘要计算（streak、去重、日期校验）
- 内容安全过滤
- **事务封装返回值传播**（核心：验证 `runTransaction` 正确返回回调结果）

## 环境变量

参见 `.env.example`，关键配置：

| 变量 | 说明 |
|------|------|
| `MONGO_URI` | MongoDB 连接字符串（需包含 `replicaSet=rs0`） |
| `JWT_SECRET` | JWT 签名密钥 |
| `AI_API_KEY` | AI 服务 API Key |
| `AI_BASE_URL` | OpenAI 兼容 API 地址 |
| `AUTH_TOKEN` | 旧版 Token 鉴权 |
| `APP_USERS` | JWT 登录用户表（JSON 数组） |
| `ALLOWED_ORIGINS` | CORS 白名单 |
| `BLOCKED_TERMS` | 内容安全屏蔽词 |

## 迁移说明

本项目从腾讯云 CloudBase 迁移而来，主要变更：

| CloudBase | 迁移后 |
|-----------|--------|
| `@cloudbase/node-sdk` | MongoDB Driver + 兼容封装层 |
| `app.ai().createModel()` | OpenAI 兼容 API |
| CloudBase Auth | JWT 本地签发 |
| 15 个云函数 | Express 单体路由 |
| 6 个 TCB Trigger | node-cron |
| CloudBase 数据库 | MongoDB 副本集 |

## License

Private
