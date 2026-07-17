#!/bin/bash
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check() {
  local name="$1" pidfile="$ROOT_DIR/$1.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name: RUNNING (PID $(cat "$pidfile"))"
  else
    echo "$name: stopped"
  fi
}
check "backend"
check "frontend"
