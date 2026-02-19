# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build && ls -la /app/dist

# Production stage
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3020 \
    HOSTNAME=0.0.0.0

WORKDIR /app

RUN apk add --no-cache dumb-init

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY package*.json ./
RUN npm i --only=production && npm cache clean --force
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

RUN mkdir -p logs && chown -R nodejs:nodejs logs

EXPOSE 3020

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/main.js"]
