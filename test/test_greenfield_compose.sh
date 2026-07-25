#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
PROJECT="redman-greenfield-$$"
WEB_PORT=$((20000 + ($$ % 10000)))
PEER_PORT=$((WEB_PORT + 1))
CONTROL_TARGET="$PROJECT-control-target"
MONITOR_ENV="$FIXTURE/docker-monitoring.env"

cleanup() {
  docker rm -f "$CONTROL_TARGET" >/dev/null 2>&1 || true
  if [[ -f "$MONITOR_ENV" ]]; then
    docker compose -p "$PROJECT" --env-file "$MONITOR_ENV" --profile docker-monitoring down -v >/dev/null 2>&1 || true
  else
    docker compose -p "$PROJECT" down -v >/dev/null 2>&1 || true
  fi
  rm -rf "$FIXTURE"
}
trap cleanup EXIT

mkdir -p "$FIXTURE/data/ssh-keys" "$FIXTURE/storage" "$FIXTURE/media"
install -m 0600 /dev/null "$FIXTURE/data/ssh-keys/authorized_keys"

export REDMAN_DATA_PATH="$FIXTURE/data"
export REDMAN_STORAGE_PATH="$FIXTURE/storage"
export REDMAN_MEDIA_PATH="$FIXTURE/media"
export REDMAN_HOST_AUTHORIZED_KEYS_PATH="$FIXTURE/data/ssh-keys/authorized_keys"
export REDMAN_WEB_PORT="$WEB_PORT"
export REDMAN_PEER_BIND=127.0.0.1
export REDMAN_PEER_PUBLISHED_PORT="$PEER_PORT"
export AUTH_MODE=local
export REDMAN_PUBLIC_ORIGIN=https://redman.test
export TRUSTED_PROXIES=127.0.0.1/32
export PEER_HOST=192.168.1.20
export PROXY_AUTO_PROVISION_ROLE=
export REDMAN_BOOTSTRAP_TOKEN=greenfield-bootstrap-token-0123456789abcdef
export DOCKER_HOST=
export DOCKER_CONTROL_HOST=
export TZ=UTC

cd "$ROOT"
docker compose -p "$PROJECT" up -d --build --wait --wait-timeout 60 redman
public_health="$(curl -fsS "http://127.0.0.1:$WEB_PORT/api/health")"
node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.status !== "ok" || health.hostname !== null || health.platform !== null
      || health.nodeVersion !== null || health.memory !== null || health.pid !== null
      || health.runningJobs !== null) process.exit(1);
' "$public_health"
curl -fsS "http://127.0.0.1:$WEB_PORT/api/auth/status" | grep -q '"requiresBootstrap":true'
curl -fsS \
  -c "$FIXTURE/auth-cookies.txt" \
  -H 'Origin: https://redman.test' \
  -H 'Content-Type: application/json' \
  --data '{"bootstrap_token":"greenfield-bootstrap-token-0123456789abcdef","username":"admin","password":"Greenfield-test-password-2026","display_name":"Greenfield Admin"}' \
  "http://127.0.0.1:$WEB_PORT/api/auth/bootstrap" | grep -q '"username":"admin"'
detail_health="$(curl -fsS -b "$FIXTURE/auth-cookies.txt" "http://127.0.0.1:$WEB_PORT/api/health/details")"
node -e '
  const health = JSON.parse(process.argv[1]);
  if (!health.hostname || !health.platform || !health.nodeVersion
      || !health.memory || !Number.isInteger(health.pid)) process.exit(1);
' "$detail_health"
curl -fsS "http://127.0.0.1:$WEB_PORT/api/auth/status" | grep -q '"requiresBootstrap":false'
curl -fsS \
  -H 'Origin: https://redman.test' \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"Greenfield-test-password-2026"}' \
  "http://127.0.0.1:$WEB_PORT/api/auth/login" | grep -q '"username":"admin"'
docker compose -p "$PROJECT" ps --services --status running | grep -qx redman
! docker compose -p "$PROJECT" ps --services --status running | grep -q docker-socket-proxy
! docker compose -p "$PROJECT" ps --services --status running | grep -q docker-control-proxy
docker compose -p "$PROJECT" exec -T redman sh -c '
  test ! -d /app/backend/node_modules/ssh2/test
  test ! -d /app/backend/node_modules/split-ca/test
  ! find /app/backend/node_modules -type f \( -name "*.pem" -o -name "*.ppk" \) -print -quit | grep -q .
'

docker compose -p "$PROJECT" exec -T redman node --input-type=module -e "
  import { authorizeKey, revokeKey } from './src/services/sshManager.js';
  const key = 'ssh-ed25519 ' + Buffer.from('greenfield-managed-host-key').toString('base64') + ' greenfield@test';
  const authorized = authorizeKey(key, { allowedPathPrefix: process.env.REDMAN_STORAGE_ROOTS.split(',')[0], sourceIp: '127.0.0.1' });
  if (!authorized.hostManaged || !authorized.restricted) process.exit(1);
  const revoked = revokeKey(key);
  if (!revoked.hostManaged || !revoked.revoked) process.exit(1);
"

docker compose -p "$PROJECT" exec -T redman node --input-type=module -e "
  import Database from 'better-sqlite3';
  import { storageConfig } from './src/services/storageConfig.js';
  const db = new Database('/app/backend/data/redman.db', { readonly: true });
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
  const expected = process.env.REDMAN_STORAGE_ROOTS.split(',');
  if (version !== 27 || JSON.stringify(storageConfig.roots) !== JSON.stringify(expected)) process.exit(1);
  db.close();
"

printf '%s\n' \
  'DOCKER_HOST=http://docker-socket-proxy:2375' \
  'DOCKER_CONTROL_HOST=http://docker-control-proxy:2375' > "$MONITOR_ENV"
unset DOCKER_HOST DOCKER_CONTROL_HOST
docker compose -p "$PROJECT" --env-file "$MONITOR_ENV" --profile docker-monitoring up -d --build --wait --wait-timeout 60
docker compose -p "$PROJECT" --env-file "$MONITOR_ENV" --profile docker-monitoring ps --services --status running | grep -qx docker-socket-proxy
docker compose -p "$PROJECT" --env-file "$MONITOR_ENV" --profile docker-monitoring ps --services --status running | grep -qx docker-control-proxy

docker create --name "$CONTROL_TARGET" alpine:3.22 tail -f /dev/null >/dev/null
CONTROL_TARGET_ID="$(docker inspect -f '{{.Id}}' "$CONTROL_TARGET" | cut -c1-12)"
docker compose -p "$PROJECT" --env-file "$MONITOR_ENV" --profile docker-monitoring exec -T redman node --input-type=module -e "
  import { containerAction, isDockerAvailable, listContainers } from './src/services/docker.js';
  const targetName = '$CONTROL_TARGET';
  const targetId = '$CONTROL_TARGET_ID';
  if (!await isDockerAvailable()) process.exit(1);
  if (!(await listContainers()).some(container => container.name === targetName && container.id === targetId)) process.exit(1);
  await containerAction(targetId, 'start');
  await containerAction(targetId, 'restart');
  await containerAction(targetId, 'stop');
"
test "$(docker inspect -f '{{.State.Running}}' "$CONTROL_TARGET")" = false

echo "Greenfield Compose: empty paths, managed host keys, redacted public health, authenticated details, local bootstrap/login, schema 27, generic roots, and optional exact-path Docker monitoring/control passed"