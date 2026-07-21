# Multi-stage production Dockerfile for ModelWiki Fastify Backend
# Stage 1: Build stage
FROM node:22-alpine AS builder

RUN apk add --no-cache openssl python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

ENV PRISMA_CLI_BINARY_TARGETS=native,linux-musl-openssl-3.0.x
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Lean Runner Stage
FROM node:22-alpine AS runner

RUN apk add --no-cache openssl wget

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]