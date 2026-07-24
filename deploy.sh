#!/bin/bash
# ============================================================
# cheer-service 部署脚本 — 本地一键部署到远程机器
# 用法: ./deploy.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 加载部署配置 ──
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

# ── 0. 前置检查 ──
log "检查前置条件..."

command -v ssh >/dev/null 2>&1 || err "需要 ssh 客户端（Git Bash 自带）"
command -v scp >/dev/null 2>&1 || err "需要 scp 客户端"
command -v tar >/dev/null 2>&1 || err "需要 tar"

# 测试 SSH 连通性
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "echo ok" >/dev/null 2>&1; then
  warn "无法免密 SSH 连接到 ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PORT}"
  warn "请先配置 SSH Key: ssh-copy-id ${DEPLOY_USER}@${DEPLOY_HOST}"
  warn "或将公钥添加到远程 ~/.ssh/authorized_keys"
  exit 1
fi
log "SSH 连接正常 ✅"

# ── 1.5. 部署 kpl-data-daily（同步 Python 爬虫代码到远程）──
KPL_SOURCE_DIR="${KPL_SOURCE_DIR:-../kpl-data-daily}"
if [ -d "${KPL_SOURCE_DIR}" ]; then
  log "同步 kpl-data-daily 到远程 /root/kpl-data-daily..."
  ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "mkdir -p /root/kpl-data-daily"
  rsync -avz -e "ssh -p $DEPLOY_PORT" \
    --exclude='data/*.json' \
    --exclude='__pycache__' \
    --exclude='.venv' \
    --exclude='*.tar.gz' \
    "${KPL_SOURCE_DIR}/" "${DEPLOY_USER}@${DEPLOY_HOST}:/root/kpl-data-daily/"
  log "kpl-data-daily 同步完成 ✅"
else
  warn "kpl-data-daily 目录不存在 (${KPL_SOURCE_DIR})，跳过同步"
fi

# ── 2. 打包源码 ──
log "打包源码（排除 node_modules / data / .git）..."

cd "$SCRIPT_DIR"
tar -czf "$ARCHIVE" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data/mongodb' \
  --exclude='data/export' \
  --exclude='.env.deploy' \
  --exclude='deploy.sh' \
  --exclude='*.tar.gz' \
  .

ARCHIVE_SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "打包完成: ${ARCHIVE} (${ARCHIVE_SIZE})"

# ── 2. 上传到远程 ──
log "上传到 ${DEPLOY_HOST}..."
scp -P "$DEPLOY_PORT" "$ARCHIVE" "${DEPLOY_USER}@${DEPLOY_HOST}:/tmp/"
log "上传完成 ✅"

# ── 3. 远程部署 ──
log "远程部署中..."

# 备份远程 .env（避免被覆盖）
ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s << ENDSSH
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
log()  { echo -e "\${GREEN}[remote]\${NC} \$*"; }
warn() { echo -e "\${RED}[remote]\${NC} \$*"; }

# ── 确保远程目录存在 ──
if [ ! -d "${DEPLOY_DIR}" ]; then
  log "首次部署，创建目录 ${DEPLOY_DIR}"
  mkdir -p "${DEPLOY_DIR}"
fi

cd "${DEPLOY_DIR}"

# ── 备份 .env ──
if [ -f .env ]; then
  cp .env /tmp/cheer-service.env.bak
  log "已备份远程 .env → /tmp/cheer-service.env.bak"
fi

# ── 解压覆盖 ──
log "解压源码..."
tar -xzf "$ARCHIVE"
rm "$ARCHIVE"

# ── 恢复 .env ──
if [ -f /tmp/cheer-service.env.bak ]; then
  cp /tmp/cheer-service.env.bak .env
  rm /tmp/cheer-service.env.bak
  log "已恢复远程 .env"
else
  warn "远程 .env 不存在，请确保 .env 文件已配置"
  warn "可参考 .env.example 创建"
fi

# ── 重建 api 容器 ──
log "停止旧容器..."
docker compose down api 2>/dev/null || true

log "构建新镜像..."
docker compose build api

log "启动新容器..."
docker compose up -d api

# ── 等待启动 ──
log "等待服务就绪..."
for i in \$(seq 1 15); do
  if docker compose ps api | grep -q 'Up'; then
    break
  fi
  sleep 2
done

# ── 健康检查 ──
log "健康检查..."
sleep 2
if docker compose exec -T api node -e "
  const http = require('http');
  http.get('http://localhost:3000/api/health', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const j = JSON.parse(data);
      process.exit(j.status === 'ok' ? 0 : 1);
    });
  }).on('error', () => process.exit(1));
" 2>/dev/null; then
  log "健康检查通过 ✅"
else
  warn "容器内健康检查失败，尝试外部检查..."
  sleep 3
fi

log "部署完成 ✅"
ENDSSH

# ── 4. 外部健康检查（可选）──
log "外部健康检查 (${HEALTH_URL})..."
sleep 2
if curl -sf --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; then
  log "外部可达 ✅"
else
  warn "外部健康检查超时（可能正常，cloudflared 隧道延迟较高）"
fi

# ── 清理本地归档 ──
rm -f "$ARCHIVE"

echo ""
log "============================================"
log "部署完成！"
log "  API:  ${HEALTH_URL}"
log "  SSH:  ssh ${DEPLOY_USER}@${DEPLOY_HOST}"
log "  Logs: ssh ${DEPLOY_USER}@${DEPLOY_HOST} 'docker compose logs -f api'"
log "============================================"
