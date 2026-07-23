FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server/src/ ./server/src/

EXPOSE 3000

CMD ["node", "server/src/app.js"]
