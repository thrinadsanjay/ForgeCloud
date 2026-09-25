#!/bin/sh
# Build Forge entirely inside containers (no host npm).
#
# Debian/Proxmox AppArmor docker-default blocks Node child_process during
# `docker build` RUN steps. `docker run --security-opt apparmor=unconfined`
# works, so npm/vite/prisma run that way; the image Dockerfile only packs
# the results (no Node spawn during `docker build`).
#
# Usage:
#   ./build.sh
#   docker compose up -d
#
# Or: ./build.sh --up

set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
BUILD="$ROOT/.build"
NODE_IMAGE=node:20-alpine
APPARMOR_OPT="--security-opt apparmor=unconfined"

docker_npm() {
  # $1 = work subdirectory under repo (frontend|backend)
  # remaining args = command
  sub=$1
  shift
  docker run --rm $APPARMOR_OPT \
    -v "$ROOT/$sub:/src:ro" \
    -v "$BUILD/$sub:/out" \
    -w /work \
    "$NODE_IMAGE" \
    sh -c "
      set -eu
      cp -a /src/. /work/
      $*
    "
}

echo "==> Preparing .build/"
rm -rf "$BUILD"
mkdir -p "$BUILD/frontend" "$BUILD/backend"

echo "==> Frontend: npm ci && npm run build (container)"
docker_npm frontend '
  npm ci
  npm run build
  cp -a dist /out/dist
'

echo "==> Backend: npm ci && prisma generate (container)"
docker_npm backend '
  apk add --no-cache openssl >/dev/null
  npm ci
  npx prisma generate
  # Pack install + generated client for the runtime image
  cp -a node_modules /out/node_modules
  cp -a package.json package-lock.json /out/
'

echo "==> Image: docker compose build"
cd "$ROOT"
docker compose build forge

echo "==> Done. Start with: docker compose up -d"
if [ "${1:-}" = "--up" ]; then
  docker compose up -d
fi
