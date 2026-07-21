# syntax=docker/dockerfile:1

# Forge — single-image build.
#
#   docker compose up -d --build
#
# Requires PostgreSQL (see docker-compose.yml `db` service).

FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# Fail fast if host files arrived empty (seen on Windows Docker Desktop file-sync races).
RUN test -s package.json && test -s package-lock.json
RUN npm ci
COPY backend/prisma ./prisma
RUN npx prisma generate

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4100 \
    ANSIBLE_ROOT=/app/ansible
WORKDIR /app

USER root
RUN apk add --no-cache ansible openssh-client sshpass python3 py3-yaml py3-passlib \
  && mkdir -p /app/ansible

COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json backend/package-lock.json ./backend/
RUN test -s ./backend/package.json && test -s ./backend/package-lock.json
COPY backend/prisma ./backend/prisma
COPY backend/src ./backend/src
COPY ansible ./ansible
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN chown -R node:node /app
USER node
WORKDIR /app/backend
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4100)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
