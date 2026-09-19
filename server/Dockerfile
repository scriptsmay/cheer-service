FROM node:22-alpine

# 国内镜像源加速（腾讯云机器走腾讯镜像，通用兼容阿里镜像备选）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.cloud.tencent.com|g' /etc/apk/repositories && \
    apk upgrade --no-cache && \
    apk add --no-cache tzdata

# kpl-data-daily 数据采集在宿主机 systemd timer 执行（业务分离），容器只读挂载数据
# 同步 MongoDB，无 python/git/ssh 依赖

WORKDIR /app

COPY package.json ./
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ && \
    npm install --production

COPY server/src/ ./server/src/
COPY server/public/ ./server/public/
# 运维脚本纳入镜像：重复率周报等需在容器内连生产 Mongo 执行（宿主机无法解析 mongodb 服务名）
COPY scripts/ ./scripts/

EXPOSE 3000

CMD ["sh", "-c", "node server/src/app.js 2>&1 | while IFS= read -r line; do echo \"$(date '+%Y-%m-%d %H:%M:%S') $line\"; done | tee -a /app/logs/api-$(date +%Y%m%d).log"]
