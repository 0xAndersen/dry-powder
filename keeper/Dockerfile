# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S -g 1001 keeper && adduser -S -u 1001 -G keeper keeper
COPY --from=builder --chown=keeper:keeper /app/package.json ./
COPY --from=builder --chown=keeper:keeper /app/node_modules ./node_modules
COPY --from=builder --chown=keeper:keeper /app/dist ./dist
USER keeper
CMD ["node", "dist/index.js"]
