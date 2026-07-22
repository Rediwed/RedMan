#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/test/data/browser-smoke"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

export DB_PATH="$DATA_DIR/redman.db"
export PORT=18990
export PEER_API_PORT=18991
export PEER_HOST=127.0.0.1
export VITE_PORT=18992
export VITE_HOST=127.0.0.1
export VITE_API_URL=http://127.0.0.1:18990
export AUTH_DISABLED=true
export REDMAN_LOCAL_DEV=1
export NODE_ENV=test

exec npm --prefix "$ROOT/app" run dev