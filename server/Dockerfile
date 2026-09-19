FROM node:22-alpine

# 国内镜像源加速（腾讯云机器走腾讯镜像，通用兼容阿里镜像备选）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.cloud.tencent.com|g' /etc/apk/repositories && \
    apk upgrade --no-cache && \
    apk add --no-cache python3 py3-pip git openssh-client tzdata

# 运行时已通过 GIT_SSH_COMMAND 配置 StrictHostKeyChecking=accept-new
# 首次 git push 时会自动接受 github.com 的 host key，无需构建时预置
# 原 ssh-keyscan github.com 会访问 22 端口，CNB 构建环境禁止

WORKDIR /app

COPY package.json ./
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ && \
    npm install --production

# 新增: 安装 kpl-data-daily Python 依赖（纯 Python，无需 C 编译器）
COPY kpl-requirements.txt ./
RUN pip3 install --break-system-packages \
    -i https://mirrors.cloud.tencent.com/pypi/simple/ \
    -r kpl-requirements.txt

COPY server/src/ ./server/src/
COPY server/public/ ./server/public/
# 运维脚本纳入镜像：重复率周报等需在容器内连生产 Mongo 执行（宿主机无法解析 mongodb 服务名）
COPY scripts/ ./scripts/

EXPOSE 3000

CMD ["sh", "-c", "node server/src/app.js 2>&1 | while IFS= read -r line; do echo \"$(date '+%Y-%m-%d %H:%M:%S') $line\"; done | tee -a /app/logs/api-$(date +%Y%m%d).log"]
