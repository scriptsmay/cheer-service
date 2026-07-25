FROM node:22-alpine

# 先 upgrade 基础层系统包(openssl/curl/libxml2/musl 等)修复 alpine 层 CVE,
# 再装业务依赖。node:22-alpine 是滚动 tag, 远程机器缓存的旧构建基础层常带已知漏洞
RUN apk upgrade --no-cache && \
    apk add --no-cache python3 py3-pip git openssh-client

# 预置 github.com 的 SSH host key, 避免容器内首次 git push 卡在 host key 确认(spawn 无 tty 会失败)
# 写到 /etc/ssh/ssh_known_hosts, 所有用户全局生效, 不依赖运行时 HOME
RUN ssh-keyscan -t rsa,ecdsa,ed25519 github.com > /etc/ssh/ssh_known_hosts

WORKDIR /app

COPY package.json ./
RUN npm install --production

# 新增: 安装 kpl-data-daily Python 依赖（纯 Python，无需 C 编译器）
COPY kpl-requirements.txt ./
RUN pip3 install --break-system-packages -r kpl-requirements.txt

COPY server/src/ ./server/src/

EXPOSE 3000

CMD ["node", "server/src/app.js"]
