# cheer-service Vercel 部署环境变量配置

## 必需配置

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `NODE_ENV` | 运行环境 | `production` |
| `PORT` | 服务端口 | `3000` |
| `SCHEDULER_ENABLED` | 调度器开关（Vercel 设为 false） | `false` |
| `CRON_SECRET` | Cron 鉴权密钥 | `<随机生成>` |

## 数据库配置（Supabase）

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `POSTGRES_URI` | **必需** Postgres 完整连接串（含主机/端口/数据库/密码） | `postgresql://postgres:<password>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require` |
| `DB_DRIVER` | 数据库驱动（postgres/mongo） | `postgres` |
| `PG_SCHEMA` | Schema 名称（默认 cheer） | `cheer` |
| `PG_POOL_MAX` | 连接池最大连接数（默认 5） | `5` |

## 数据库回退（Mongo）

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `MONGO_URI` | Mongo 连接串（DB_DRIVER=mongo 时生效，回退用） | `<Mongo 连接串>` |

## Upstash Redis（可选）

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL | `<从 Upstash 控制台获取>` |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token | `<从 Upstash 控制台获取>` |

## AI 配置

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `AI_BASE_URL` | AI API 基础地址 | `https://api.kplwuyan.site` |
| `AI_API_KEY` | AI API 密钥 | `<密钥>` |
| `AI_MODEL` | AI 模型 | `qwen-turbo` |
| `AI_THINKING_BUDGET` | 思考预算 | `0` |

## KPL 数据源

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `KPL_SOURCE` | 数据源（github/local） | `github` |
| `KPL_GITHUB_RAW_BASE` | GitHub raw 基础地址 | `https://github.matishare.com/proxy/https://raw.githubusercontent.com/scriptsmay/kpl_data_daily/main` |

## 鉴权配置

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `AUTH_TOKEN` | API 鉴权令牌 | `wuyan_mini_20260710` |

## 配置步骤

1. 登录 [Vercel 控制台](https://vercel.com/)
2. 选择或创建项目
3. 进入 **Settings → Environment Variables**
4. 添加上述环境变量
5. 重新部署以生效

## 注意事项

- `SCHEDULER_ENABLED` 必须设为 `false`，定时任务走 Vercel Cron
- `CRON_SECRET` 建议随机生成，用于 `/api/cron/daily` 鉴权
- 数据库密码等敏感信息不要提交到代码仓库
