FROM node:22-alpine

# 国内镜像源加速（腾讯云机器走腾讯镜像，通用兼容阿里镜像备选）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.cloud.tencent.com|g' /etc/apk/repositories && \
    apk upgrade --no-cache && \
    apk add --no-cache python3 py3-pip git openssh-client

# 预置 github.com 的 SSH host key, 避免容器内首次 git push 卡在 host key 确认(spawn 无 tty 会失败)
# 写到 /etc/ssh/ssh_known_hosts, 所有用户全局生效, 不依赖运行时 HOME
RUN ssh-keyscan -t rsa,ecdsa,ed25519 github.com > /etc/ssh/ssh_known_hosts

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

EXPOSE 3000

CMD ["node", "server/src/app.js"]
