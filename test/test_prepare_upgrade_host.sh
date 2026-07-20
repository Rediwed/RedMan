#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
IMAGE="redman-upgrade-bridge-test:$$"
CONTAINER="redman-upgrade-bridge-test-$$"
HOST_FIXTURE_IMAGE="redman-upgrade-host-fixture:$$"
DATA_DIR="$FIXTURE/data"
BACKUP_DIR="$FIXTURE/backups"
BOOT_DIR="$FIXTURE/boot-config"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
  docker image rm -f "$HOST_FIXTURE_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$FIXTURE"
}
trap cleanup EXIT

mkdir -p "$DATA_DIR" "$BACKUP_DIR" "$BOOT_DIR"
: > "$BOOT_DIR/go"

docker build -t "$IMAGE" "$ROOT" >/dev/null
docker build -f "$ROOT/test/Dockerfile.host-fixture" -t "$HOST_FIXTURE_IMAGE" "$ROOT" >/dev/null
docker run --rm \
  -v "$DATA_DIR:/app/backend/data" \
  "$IMAGE" node src/seed.js >/dev/null

docker run -d \
  --name "$CONTAINER" \
  -e AUTH_DISABLED=true \
  -e NODE_ENV=test \
  -e REDMAN_UPGRADE_BRIDGE=true \
  -e PEER_HOST=127.0.0.1 \
  -v "$DATA_DIR:/app/backend/data" \
  "$IMAGE" >/dev/null

docker exec "$CONTAINER" node --input-type=module -e '
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:8090/api/health");
      if (response.ok) process.exit(0);
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  process.exit(1);
'

docker exec "$CONTAINER" node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:8090/");
  const body = await response.text();
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")
      || !body.includes("<div id=\"root\"></div>")) process.exit(1);
'

docker exec "$CONTAINER" node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:8090/api/upgrade-readiness/backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  const payload = await response.json();
  if (!payload.success || payload.backup.integrity !== "ok") process.exit(1);
'

run_host_preparation() {
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$ROOT/scripts:/bridge-scripts:ro" \
    -v "$DATA_DIR:/srv/redman" \
    -v "$BACKUP_DIR:/srv/backups" \
    -v "$BOOT_DIR:/boot/config" \
    "$HOST_FIXTURE_IMAGE" sh -c "
    set -eu
    ssh-keygen -A >/dev/null 2>&1
    mkdir -p /etc/rc.d
    printf '#!/bin/sh\nexit 0\n' > /etc/rc.d/rc.sshd
    chmod 0755 /etc/rc.d/rc.sshd
    /bridge-scripts/prepare-upgrade-host.sh \\
      --platform unraid \\
      --container '$CONTAINER' \\
      --data-dir /srv/redman \\
      --backup-root /srv/backups
  "
}

ln -s /etc/hosts "$DATA_DIR/identity.json"
if run_host_preparation >/tmp/redman-upgrade-host-symlink.log 2>&1; then
  echo "Symlinked app-data artifact unexpectedly passed host preparation" >&2
  exit 1
fi
rm -f "$DATA_DIR/identity.json"
test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = true

EXTERNAL_RECEIPT_TARGET="$FIXTURE/external-receipt-target"
printf 'sentinel\n' > "$EXTERNAL_RECEIPT_TARGET"
ln -s "$EXTERNAL_RECEIPT_TARGET" "$DATA_DIR/upgrade-readiness/host-prepared.json"
if run_host_preparation >/tmp/redman-upgrade-receipt-symlink.log 2>&1; then
  echo "Symlinked receipt destination unexpectedly passed host preparation" >&2
  exit 1
fi
test "$(cat "$EXTERNAL_RECEIPT_TARGET")" = sentinel
rm -f "$DATA_DIR/upgrade-readiness/host-prepared.json"
test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = true

run_host_preparation >/tmp/redman-upgrade-host-test.log

node - "$DATA_DIR" <<'NODE'
const { existsSync, readFileSync, statSync } = require('fs');
const { join } = require('path');
const dataDir = process.argv[2];
const receiptPath = join(dataDir, 'upgrade-readiness', 'host-prepared.json');
if (!existsSync(receiptPath)) process.exit(1);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (receipt.bridgeVersion !== 1 || receipt.platform !== 'unraid' || receipt.user !== 'redman-backup') process.exit(1);
const rollbackDir = join(dataDir, receipt.rollbackRelativePath.replace(/^upgrade-readiness\//, 'upgrade-readiness/'));
if (!receipt.backupRoots.includes('/srv/backups') || !existsSync(rollbackDir)
  || !Array.isArray(receipt.artifacts) || receipt.artifacts.length < 2
  || !/^[a-f0-9]{64}$/.test(receipt.applicationBackupSha256)) process.exit(1);
for (const path of [
  receiptPath,
  join(dataDir, 'ssh-keys', 'authorized_keys'),
  join(rollbackDir, 'redman.db'),
  join(rollbackDir, 'container-inspect.json'),
]) {
  if (!existsSync(path)) process.exit(1);
  if ((statSync(path).mode & 0o777) !== 0o600) process.exit(1);
}
NODE

grep -q '^/boot/config/plugins/redman/setup-unraid-backup-user.sh ' "$BOOT_DIR/go"
test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = true
docker exec "$CONTAINER" node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:8090/api/upgrade-readiness");
  if (!response.ok) process.exit(1);
  const assessment = await response.json();
  if (assessment.hostPreparation.status !== "ready" || assessment.applicationBackup.status !== "ready") process.exit(1);
'
ROLLBACK_RELATIVE="$(node -p "JSON.parse(require('fs').readFileSync('$DATA_DIR/upgrade-readiness/host-prepared.json', 'utf8')).rollbackRelativePath")"
printf 'corrupt\n' >> "$DATA_DIR/$ROLLBACK_RELATIVE/redman.db"
docker exec "$CONTAINER" node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:8090/api/upgrade-readiness");
  if (!response.ok) process.exit(1);
  const assessment = await response.json();
  if (assessment.hostPreparation.status !== "invalid") process.exit(1);
'
echo "Upgrade host preparation: verified backup, rollback snapshot, restricted account, receipt, and Unraid persistence passed"
