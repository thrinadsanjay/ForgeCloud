# syntax=docker/dockerfile:1

# Forge runtime image — packs artifacts from ./build.sh (container npm builds).
#
#   ./build.sh && docker compose up -d
#
# Do not run `docker compose build` alone on AppArmor-broken hosts; use build.sh
# so npm/vite/prisma run under apparmor=unconfined.

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4100 \
    ANSIBLE_ROOT=/app/ansible
WORKDIR /app

USER root
RUN apk add --no-cache ansible openssh-client sshpass python3 py3-yaml py3-passlib \
    docker-cli docker-cli-compose git openssl curl \
  && mkdir -p /app/ansible \
  && KARCH="$(uname -m)"; \
     case "$KARCH" in x86_64) KARCH=amd64 ;; aarch64) KARCH=arm64 ;; armv7l) KARCH=arm ;; *) KARCH=amd64 ;; esac; \
     KVER="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" && \
     curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KVER}/bin/linux/${KARCH}/kubectl" && \
     chmod +x /usr/local/bin/kubectl && kubectl version --client --output=yaml >/dev/null

# Prebuilt by ./build.sh (npm ci + prisma generate in a privileged-apparmor container)
COPY .build/backend/node_modules ./backend/node_modules
COPY .build/backend/package.json .build/backend/package-lock.json ./backend/
RUN test -s ./backend/package.json && test -s ./backend/package-lock.json
COPY backend/prisma ./backend/prisma
COPY backend/src ./backend/src
COPY ansible ./ansible
COPY .build/frontend/dist ./frontend/dist

RUN chown -R node:node /app
USER node
WORKDIR /app/backend
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4100)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
