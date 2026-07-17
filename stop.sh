#!/bin/bash
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stop_one() {
  local name="$1" pidfile="$ROOT_DIR/$1.pid"
  if [ -f "$pidfile" ]; then
    local pid; pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      pkill -P "$pid" 2>/dev/null
      kill "$pid" 2>/dev/null
      echo "Stopped $name (PID $pid)"
    else
      echo "$name not running (stale PID file)"
    fi
    rm -f "$pidfile"
  else
    echo "$name not running (no PID file)"
  fi
}
stop_one "backend"
stop_one "frontend"

# node --watch can leave orphaned children that keep holding the port after the
# tracked PID is gone, which makes the next start race on EADDRINUSE. Free the
# ports directly so a stop always leaves a clean slate.
free_port() {
  local port="$1" pids
  pids="$(netstat -ano 2>/dev/null | grep -E ":${port}[[:space:]]" | grep LISTENING | awk '{print $NF}' | sort -u)"
  for pid in $pids; do
    taskkill //F //PID "$pid" >/dev/null 2>&1 && echo "Freed port $port (orphan PID $pid)"
  done
}
free_port 4100
free_port 5273
