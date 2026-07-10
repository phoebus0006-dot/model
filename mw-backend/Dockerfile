FROM node:22-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

EXPOSE 3000

CMD ["node", "dist/index.js"]