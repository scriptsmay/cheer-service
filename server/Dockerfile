FROM node:22-alpine

# 国内镜像源加速（腾讯云机器走腾讯镜像，通用兼容阿里镜像备选）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.cloud.tencent.com|g' /etc/apk/repositories && \
    apk upgrade --no-cache && \
    apk add --no-cache python3 py3-pip tzdata

# kpl-data-daily 数据采集已迁移到宿主机 systemd timer
# 容器内不再需要 git/ssh 功能，移除相关依赖
# 数据通过 docker-compose.yml 卷挂载读取

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
