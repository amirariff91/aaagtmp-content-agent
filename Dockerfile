FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY webhook.js .

EXPOSE 3210

CMD ["node", "webhook.js"]
