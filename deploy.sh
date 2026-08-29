#!/bin/bash
# ============================================================
# cheer-service 部署脚本 -- 本地一键部署到远程机器
# 用法: ./deploy.sh
# 流程: 打包源码 → 上传 → 远程解压(保留 .env/logs) → 构建新镜像(旧容器在线)
#       → down/up 切换 → 健康检查(失败自动回滚上一版本镜像并 exit 1)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# -- 加载部署配置 --
if [ -f "${SCRIPT_DIR}/.env.deploy" ]; then
  set -a
  source "${SCRIPT_DIR}/.env.deploy"
  set +a
else
  echo "错误: 未找到 .env.deploy 文件"
  echo "请从模板创建: cp .env.deploy.example .env.deploy"
  echo "然后填入真实服务器信息"
  exit 1
fi

# 必填校验
: "${DEPLOY_HOST:?请在 .env.deploy 中设置 DEPLOY_HOST}"
: "${DEPLOY_USER:?请在 .env.deploy 中设置 DEPLOY_USER}"
: "${DEPLOY_DIR:?请在 .env.deploy 中设置 DEPLOY_DIR}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
HEALTH_URL="${HEALTH_URL:-}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="/tmp/cheer-service-${TIMESTAMP}.tar.gz"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()  { echo -e "${RED}[error]${NC} $*"; exit 1; }

# -- 0. 前置检查 --
log "检查前置条件..."

command -v ssh >/dev/null 2>&1 || err "需要 ssh 客户端（Git Bash 自带）"
command -v scp >/dev/null 2>&1 || err "需要 scp 客户端"
command -v tar >/dev/null 2>&1 || err "需要 tar"

# ── 跨平台 tar 兼容 ──
# macOS bsdtar 会将 com.apple.provenance 等扩展属性写入 PAX header,
# 导致 Linux GNU tar 解压时报 "Ignoring unknown extended header keyword" 警告。
# COPYFILE_DISABLE=1 抑制 Apple Double 文件 (._*) 生成 (Linux 上无效但无害)。
# --no-xattrs + --no-mac-metadata 彻底去除 PAX 扩展属性 (macOS 12+ 支持)。
export COPYFILE_DISABLE=1
TAR_META_FLAGS=""
if [ "$(uname)" = "Darwin" ]; then
  TAR_META_FLAGS="--no-xattrs --no-mac-metadata"
fi

# 测试 SSH 连通性
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "echo ok" >/dev/null 2>&1; then
  warn "无法免密 SSH 连接到 ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PORT}"
  warn "请先配置 SSH Key: ssh-copy-id ${DEPLOY_USER}@${DEPLOY_HOST}"
  warn "或将公钥添加到远程 ~/.ssh/authorized_keys"
  exit 1
fi
log "SSH 连接正常"

# -- 1.5. 部署 kpl-data-daily（同步 Python 爬虫代码到远程）--
# 注意命名差异: 本地目录 kpl_data_daily(下划线) → 远程挂载 /root/kpl-data-daily(连字符)
# 远程路径必须与 docker-compose.yml 的 bind mount 一致。
# "重命名"靠解压时 --strip-components=1 实现: tar 里的 kpl_data_daily/ 前缀被剥掉,
# 内容直接落到 KPL_REMOTE_DIR, 因此本地目录名与远程无关, 改任一方都不影响。
KPL_REMOTE_DIR="${KPL_REMOTE_DIR:-/root/kpl-data-daily}"
if [ -n "${KPL_SOURCE_DIR:-}" ] && [ -d "${KPL_SOURCE_DIR}" ]; then
  log "同步 kpl-data-daily (${KPL_SOURCE_DIR}) → 远程 ${KPL_REMOTE_DIR}..."
  KPL_TAR="/tmp/kpl-data-daily-${TIMESTAMP}.tar.gz"
  tar -czf "$KPL_TAR" \
    $TAR_META_FLAGS \
    --exclude='data/*.json' \
    --exclude='__pycache__' \
    --exclude='.venv' \
    --exclude='*.tar.gz' \
    -C "${KPL_SOURCE_DIR}/.." \
    "$(basename "${KPL_SOURCE_DIR}")"
  ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "mkdir -p ${KPL_REMOTE_DIR}"
  scp -P "$DEPLOY_PORT" "$KPL_TAR" "${DEPLOY_USER}@${DEPLOY_HOST}:/tmp/"
  # --strip-components=1 去掉本地目录名前缀, 实现 kpl_data_daily → kpl-data-daily 的映射
  # chown 修复跨机 tar 解压的 git dubious ownership(Windows owner → root)
  ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" \
    "tar -xzf /tmp/$(basename "$KPL_TAR") -C ${KPL_REMOTE_DIR} --strip-components=1 && chown -R root:root ${KPL_REMOTE_DIR} && rm /tmp/$(basename "$KPL_TAR")"
  rm "$KPL_TAR"
  log "kpl-data-daily 同步完成"
else
  # 本地源目录不存在: 检查远程目录是否已有数据, 避免无意义的告警
  if ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "[ -d ${KPL_REMOTE_DIR} ]" 2>/dev/null; then
    log "本地 kpl-data-daily 目录不存在 (${KPL_SOURCE_DIR:-未配置})，远程 ${KPL_REMOTE_DIR} 已存在，跳过同步"
  else
    warn "kpl-data-daily 目录不存在 (${KPL_SOURCE_DIR:-未配置})，且远程 ${KPL_REMOTE_DIR} 也不存在"
    warn "跳过后容器挂载 ${KPL_REMOTE_DIR} 将导致采集报 No such file"
  fi
fi

# -- 2. 打包源码 --
log "打包源码（排除 node_modules / data / .git / .env）..."

cd "$SCRIPT_DIR"
tar -czf "$ARCHIVE" \
  $TAR_META_FLAGS \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data/mongodb' \
  --exclude='data/export' \
  --exclude='.env' \
  --exclude='.env.deploy' \
  --exclude='deploy.sh' \
  --exclude='*.tar.gz' \
  .

ARCHIVE_SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "打包完成: ${ARCHIVE} (${ARCHIVE_SIZE})"

# -- 3. 上传到远程 --
log "上传到 ${DEPLOY_HOST}..."
scp -P "$DEPLOY_PORT" "$ARCHIVE" "${DEPLOY_USER}@${DEPLOY_HOST}:/tmp/"
log "上传完成"

# -- 4. 远程部署 --
log "远程部署中..."

# 生成远程部署脚本（避免 heredoc 跨平台兼容问题）
REMOTE_SCRIPT="/tmp/cheer-deploy-${TIMESTAMP}.sh"
cat > "$REMOTE_SCRIPT" << 'REMOTE_EOF'
#!/bin/bash
set -euo pipefail

ARCHIVE="$1"
DEPLOY_DIR="$2"
TIMESTAMP="$3"

API_CONTAINER="wuyan-api"

log()  { echo "[remote] $*"; }
warn() { echo "[remote] $*"; }

if [ ! -d "${DEPLOY_DIR}" ]; then
  log "首次部署，创建目录 ${DEPLOY_DIR}"
  mkdir -p "${DEPLOY_DIR}"
fi

cd "${DEPLOY_DIR}"

# -- 记录当前运行镜像（失败回滚点） --
OLD_IMAGE_ID=""
OLD_IMAGE_REF=""
if docker inspect "${API_CONTAINER}" >/dev/null 2>&1; then
  OLD_IMAGE_ID=$(docker inspect --format '{{.Image}}' "${API_CONTAINER}")
  OLD_IMAGE_REF=$(docker inspect --format '{{.Config.Image}}' "${API_CONTAINER}")
  log "记录回滚点: ${OLD_IMAGE_REF} (${OLD_IMAGE_ID:0:12})"
fi

# -- 备份远程 .env（目录清理不触碰 .env，此为防新包误带 .env 的双保险） --
if [ -f .env ]; then
  cp .env /tmp/cheer-service.env.bak
  log "已备份远程 .env -> /tmp/cheer-service.env.bak"
fi

# -- 解压到 staging 目录再替换（中断不会留下半新半旧代码） --
STAGING="${DEPLOY_DIR}.staging-${TIMESTAMP}"
rm -rf "${STAGING}"
mkdir -p "${STAGING}"
trap 'rm -rf "${STAGING:-}"' EXIT
log "解压源码到 staging..."
tar -xzf "${ARCHIVE}" -C "${STAGING}"
rm -f "${ARCHIVE}"

# -- 替换旧代码；保留运行时状态（.env / logs） --
log "更新部署目录（保留 .env 与 logs）..."
find "${DEPLOY_DIR}" -mindepth 1 -maxdepth 1 ! -name '.env' ! -name 'logs' -exec rm -rf {} +
cp -a "${STAGING}"/. "${DEPLOY_DIR}/"
rm -rf "${STAGING}"

# -- 恢复 .env（以远程为准） --
if [ -f /tmp/cheer-service.env.bak ]; then
  cp /tmp/cheer-service.env.bak .env
  rm -f /tmp/cheer-service.env.bak
  log "已恢复远程 .env"
else
  warn "远程 .env 不存在，请确保 .env 文件已配置"
  warn "可参考 .env.example 创建"
fi

# -- 先构建新镜像（旧容器保持在线服务），构建失败不影响线上 --
log "构建新镜像（旧容器保持运行）..."
docker compose build api

# -- 切换：down + up 只需数秒 --
log "切换到新镜像..."
docker compose down api 2>/dev/null || true
docker compose up -d api

# -- 健康检查（严格，60s 内不通过则回滚） --
log "等待服务就绪..."
HEALTH_OK=0
for i in $(seq 1 30); do
  if docker compose exec -T api node -e '
    const http = require("http");
    http.get("http://localhost:3000/api/health", (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          process.exit(j.status === "ok" ? 0 : 1);
        } catch { process.exit(1); }
      });
    }).on("error", () => process.exit(1));
  ' 2>/dev/null; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done

if [ "${HEALTH_OK}" -ne 1 ]; then
  warn "健康检查未通过（60 秒内）"
  if [ -n "${OLD_IMAGE_ID}" ]; then
    warn "回滚到上一版本镜像..."
    docker compose down api 2>/dev/null || true
    docker tag "${OLD_IMAGE_ID}" "${OLD_IMAGE_REF}"
    docker compose up -d --force-recreate api
    warn "已回滚。请检查本地代码 / docker compose logs -f api 后重试"
  else
    warn "无回滚点（首次部署），容器保持当前状态"
  fi
  exit 1
fi

log "健康检查通过"
log "部署完成"
REMOTE_EOF

# 上传远程脚本并执行（透传远程脚本退出码，失败即中止）
scp -P "$DEPLOY_PORT" "$REMOTE_SCRIPT" "${DEPLOY_USER}@${DEPLOY_HOST}:/tmp/"
REMOTE_STATUS=0
ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "bash /tmp/$(basename "$REMOTE_SCRIPT") '$ARCHIVE' '$DEPLOY_DIR' '$TIMESTAMP'; rc=\$?; rm -f /tmp/$(basename "$REMOTE_SCRIPT"); exit \$rc" || REMOTE_STATUS=$?
rm -f "$REMOTE_SCRIPT"

if [ "${REMOTE_STATUS}" -ne 0 ]; then
  err "远程部署失败（exit ${REMOTE_STATUS}）——线上已自动回滚到上一版本，请排查后重试"
fi

# -- 5. 外部健康检查（可选，信息性质；权威判定在容器内检查）--
if [ -n "${HEALTH_URL}" ]; then
  log "外部健康检查 (${HEALTH_URL})..."
  sleep 2
  EXT_OK=0
  for i in 1 2 3; do
    if curl -sf --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; then
      EXT_OK=1
      break
    fi
    sleep 3
  done
  if [ "${EXT_OK}" -eq 1 ]; then
    log "外部可达"
  else
    warn "外部健康检查未通过（可能为 cloudflared 隧道延迟，uptime-kuma 侧可确认实际状态）"
  fi
fi

# -- 清理本地归档 --
rm -f "$ARCHIVE"

echo ""
log "============================================"
log "部署完成！"
log "  API:  ${HEALTH_URL:-无}"
log "  SSH:  ssh ${DEPLOY_USER}@${DEPLOY_HOST}"
log "  Logs: ssh ${DEPLOY_USER}@${DEPLOY_HOST} 'docker compose logs -f api'"
log "============================================"
