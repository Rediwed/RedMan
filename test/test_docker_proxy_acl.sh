#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_IMAGE="redman-docker-api-proxy:test"
SUFFIX="$$"
NETWORK="redman-proxy-test-$SUFFIX"
READ_PROXY="redman-read-proxy-$SUFFIX"
CONTROL_PROXY="redman-control-proxy-$SUFFIX"
TARGET="redman-proxy-target-$SUFFIX"

cleanup() {
  docker rm -f "$READ_PROXY" "$CONTROL_PROXY" "$TARGET" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

request_status() {
  local host=$1
  local method=$2
  local path=$3
  local expected=$4

  docker run --rm -i --network "$NETWORK" node:20-alpine node - \
    "$host" "$method" "$path" "$expected" <<'NODE'
const [host, method, path, expectedText] = process.argv.slice(2);
const expected = Number(expectedText);

for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch(`http://${host}:2375${path}`, { method });
    await response.arrayBuffer();
    if (response.status !== expected) {
      console.error(`${method} ${path}: expected ${expected}, got ${response.status}`);
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    if (attempt === 29) {
      console.error(`${method} ${path}: ${error.message}`);
      process.exit(1);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
NODE
}

docker network create "$NETWORK" >/dev/null
docker create --name "$TARGET" alpine:3.22 tail -f /dev/null >/dev/null
docker build --target docker-api-proxy -t "$PROXY_IMAGE" "$ROOT" >/dev/null

docker run -d \
  --name "$READ_PROXY" \
  --network "$NETWORK" \
  --network-alias docker-read \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  -e REDMAN_DOCKER_PROXY_MODE=read \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  "$PROXY_IMAGE" >/dev/null

docker run -d \
  --name "$CONTROL_PROXY" \
  --network "$NETWORK" \
  --network-alias docker-control \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  -e REDMAN_DOCKER_PROXY_MODE=control \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  "$PROXY_IMAGE" >/dev/null

request_status docker-read GET /containers/json 200
request_status docker-read GET /networks 200
request_status docker-read GET "/containers/$TARGET/archive?path=/etc" 403
request_status docker-read GET "/containers/$TARGET/logs" 403
request_status docker-read POST "/containers/$TARGET/start" 403
request_status docker-control POST /containers/create 403
request_status docker-control POST "/containers/$TARGET/restart" 403
request_status docker-control POST "/containers/$TARGET/kill" 403
request_status docker-control POST "/containers/$TARGET/start" 204
test "$(docker inspect -f '{{.State.Running}}' "$TARGET")" = true
request_status docker-read GET "/containers/$TARGET/stats?stream=false" 200
request_status docker-control POST "/containers/$TARGET/stop?t=1" 204
test "$(docker inspect -f '{{.State.Running}}' "$TARGET")" = false

echo "Docker proxy ACLs: exact container/network reads, stats, start, and stop allowed; archive/logs/create/restart/kill and read-proxy mutation denied"