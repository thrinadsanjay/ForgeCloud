#!/usr/bin/env bash
# Starts Forge backend and frontend in the background, detached from this shell.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required." >&2
  exit 1
fi

mkdir -p logs

if [ ! -d backend/node_modules ]; then
  echo "Installing backend dependencies..."
  (cd backend && npm install)
fi
if [ ! -d frontend/node_modules ]; then
  echo "Installing frontend dependencies..."
  (cd frontend && npm install)
fi

if [ ! -f backend/.env ]; then
  echo "Copy backend/.env from .env.example and configure DATABASE_URL, JWT_SECRET, etc." >&2
  exit 1
fi

echo "Starting backend on :4100..."
nohup bash -c 'cd backend && npm run dev' > logs/backend.log 2>&1 &
echo $! > logs/backend.pid

echo "Starting frontend on :5273..."
nohup bash -c 'cd frontend && npm run dev' > logs/frontend.log 2>&1 &
echo $! > logs/frontend.pid

echo "Forge running detached. Backend :4100  Frontend :5273"
echo "Logs: logs/backend.log  logs/frontend.log"
echo "Stop: kill \$(cat logs/backend.pid) \$(cat logs/frontend.pid)"
