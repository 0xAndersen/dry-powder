# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN addgroup -S -g 1001 keeper && adduser -S -u 1001 -G keeper keeper
USER keeper
CMD ["node", "src/main.mjs"]
