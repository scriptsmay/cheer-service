FROM node:22-alpine

# 新增: Python 3 + pip + git（用于 kpl-data-daily 爬虫 + 自动 git push 备份）
RUN apk add --no-cache python3 py3-pip git

WORKDIR /app

COPY package.json ./
RUN npm install --production

# 新增: 安装 kpl-data-daily Python 依赖（纯 Python，无需 C 编译器）
COPY kpl-requirements.txt ./
RUN pip3 install --break-system-packages -r kpl-requirements.txt

COPY server/src/ ./server/src/

EXPOSE 3000

CMD ["node", "server/src/app.js"]
