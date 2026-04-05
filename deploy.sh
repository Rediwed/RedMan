#!/bin/bash
# Deploy RedMan to Unraid
# Usage: ./deploy.sh [--seed]

set -e

REMOTE="unraid"
SRC_DIR="/mnt/user/appdata/redman-src"
DATA_DIR="/mnt/user/appdata/redman"
CONTAINER="redman"
PORT="8090"
PEER_PORT="8091"

echo "📦 Syncing files to Unraid..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.db' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  --exclude='.DS_Store' \
  "$(dirname "$0")/" "$REMOTE:$SRC_DIR/"

echo "🔨 Building image..."
ssh "$REMOTE" "cd $SRC_DIR && docker build -t $CONTAINER:latest ."

echo "🔄 Replacing container..."
ssh "$REMOTE" "docker rm -f $CONTAINER 2>/dev/null; \
  docker run -d \
    --name $CONTAINER \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    -p $PORT:8090 \
    -p $PEER_PORT:8091 \
    -v $DATA_DIR:/app/backend/data \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v /boot/config/shares:/boot/config/shares:ro \
    -v /mnt/user:/mnt/user:ro \
    -v /mnt/cache:/mnt/cache:ro \
    -e NODE_ENV=production \
    -e PORT=8090 \
    -e PEER_PORT=8091 \
    --restart unless-stopped \
    $CONTAINER:latest"

if [[ "\$1" == "--seed" ]]; then
  echo "🌱 Seeding database..."
  ssh "$REMOTE" "docker exec $CONTAINER node src/seed.js"
fi

echo "✅ Live at http://192.168.1.17:$PORT"
