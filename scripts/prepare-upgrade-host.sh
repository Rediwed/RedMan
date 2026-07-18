#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="redman"
PLATFORM="auto"
DATA_DIR=""
DRY_RUN=false
BACKUP_ROOTS=("")
BRIDGE_VERSION=1

usage() {
  cat <<'EOF'
Usage: prepare-upgrade-host.sh --data-dir PATH --backup-root PATH [options]

Prepares an existing RedMan host for the hardened release without replacing the
application container. It briefly stops and restarts the bridge to prevent jobs
or writes racing with rollback capture. Run the wizard backup step first.

Options:
  --platform linux|unraid|auto  Host type (default: auto)
  --container NAME             Existing bridge container (default: redman)
  --data-dir PATH              Existing RedMan host app-data path (required)
  --backup-root PATH           Approved backup root (required, repeatable)
  --dry-run                    Print and validate the plan without host changes
  --help                       Show this help
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

usage_error() {
  echo "Error: $*" >&2
  usage >&2
  exit 2
}

absolute_path() {
  local label=$1
  local value=$2
  [[ "$value" == /* && "$value" != "/" ]] || usage_error "$label must be a non-root absolute path"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || usage_error "$label contains unsupported characters"
  [[ "/$value/" != *"/../"* ]] || usage_error "$label may not contain .. components"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --backup-root) BACKUP_ROOTS+=("${2:-}"); shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage_error "unknown option: $1" ;;
  esac
done

[[ -n "$DATA_DIR" ]] || usage_error "--data-dir is required"
[[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || usage_error "--container is invalid"
[[ "$PLATFORM" == "auto" || "$PLATFORM" == "linux" || "$PLATFORM" == "unraid" ]] || usage_error "--platform must be auto, linux, or unraid"
absolute_path "--data-dir" "$DATA_DIR"

ROOT_COUNT=0
for root in "${BACKUP_ROOTS[@]}"; do
  [[ -n "$root" ]] || continue
  absolute_path "--backup-root" "$root"
  ROOT_COUNT=$((ROOT_COUNT + 1))
done
[[ $ROOT_COUNT -gt 0 ]] || usage_error "at least one --backup-root is required"
[[ $ROOT_COUNT -le 16 ]] || usage_error "at most 16 --backup-root values are supported"

if [[ "$PLATFORM" == "auto" ]]; then
  if [[ -f /boot/config/go ]]; then PLATFORM="unraid"; else PLATFORM="linux"; fi
fi

INSTALLER="$SCRIPT_DIR/setup-backup-user.sh"
if [[ "$PLATFORM" == "unraid" ]]; then INSTALLER="$SCRIPT_DIR/setup-unraid-backup-user.sh"; fi
[[ -x "$INSTALLER" ]] || fail "installer is missing or not executable: $INSTALLER"

INSTALL_ARGS=(--data-dir "$DATA_DIR")
for root in "${BACKUP_ROOTS[@]}"; do
  [[ -n "$root" ]] && INSTALL_ARGS+=(--backup-root "$root")
done

if $DRY_RUN; then
  printf '%s\n' \
    "BRIDGE_VERSION=$BRIDGE_VERSION" \
    "PLATFORM=$PLATFORM" \
    "CONTAINER=$CONTAINER" \
    "DATA_DIR=$DATA_DIR"
  for root in "${BACKUP_ROOTS[@]}"; do [[ -n "$root" ]] && echo "BACKUP_ROOT=$root"; done
  "$INSTALLER" "${INSTALL_ARGS[@]}" --dry-run
  exit 0
fi

[[ $(id -u) -eq 0 ]] || fail "run as root (use sudo on generic Linux; Unraid terminals are already root)"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
CANONICAL_DATA_DIR="$(readlink -e -- "$DATA_DIR" 2>/dev/null)" || fail "data directory does not exist: $DATA_DIR"
[[ -d "$CANONICAL_DATA_DIR" && "$CANONICAL_DATA_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || fail "canonical data directory is invalid: $CANONICAL_DATA_DIR"
DATA_DIR="$CANONICAL_DATA_DIR"
READINESS_DIR="$DATA_DIR/upgrade-readiness"
BACKUPS_DIR="$READINESS_DIR/backups"
INSTALL_ARGS=(--data-dir "$DATA_DIR")
for root in "${BACKUP_ROOTS[@]}"; do
  [[ -n "$root" ]] && INSTALL_ARGS+=(--backup-root "$root")
done
docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "container not found: $CONTAINER"
[[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" == "true" ]] || fail "container is not running: $CONTAINER"
if [[ "$PLATFORM" == "unraid" ]]; then
  [[ -f /boot/config/go ]] || fail "Unraid boot file not found: /boot/config/go"
fi

ACTIVE_RUNS="$(docker exec "$CONTAINER" node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database('/app/backend/data/redman.db', { readonly: true, fileMustExist: true });
  const row = db.prepare(\"SELECT COUNT(*) AS count FROM backup_runs WHERE status = 'running'\").get();
  process.stdout.write(String(row.count));
  db.close();
" 2>/dev/null)" || fail "could not verify active jobs inside $CONTAINER"
[[ "$ACTIVE_RUNS" =~ ^[0-9]+$ ]] || fail "active-job check returned invalid data"
[[ "$ACTIVE_RUNS" == "0" ]] || fail "$ACTIVE_RUNS active job(s) block host preparation"

# Validate and identify the exact wizard-created online backup from inside the bridge container.
BACKUP_INFO="$(docker exec "$CONTAINER" node --input-type=module -e "
  import { createHash } from 'node:crypto';
  import Database from 'better-sqlite3';
  import { existsSync, readFileSync, statSync } from 'node:fs';
  import { resolve } from 'node:path';
  const receiptPath = '/app/backend/data/upgrade-readiness/application-backup.json';
  if (!existsSync(receiptPath)) throw new Error('application backup receipt is missing');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const relative = String(receipt.backupRelativePath || '').replace(/\\\\/g, '/');
  if (receipt.bridgeVersion !== $BRIDGE_VERSION || !relative.startsWith('upgrade-readiness/backups/')
      || relative.startsWith('/') || relative.split('/').includes('..')) throw new Error('application backup receipt is invalid');
  const backupPath = resolve('/app/backend/data', relative);
  if (!existsSync(backupPath) || statSync(backupPath).size !== receipt.sizeBytes) throw new Error('application backup size mismatch');
  const digest = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
  if (digest !== receipt.sha256) throw new Error('application backup checksum mismatch');
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('application backup integrity check failed');
  backup.close();
  process.stdout.write([relative, digest, String(receipt.sizeBytes)].join('\t'));
" 2>/dev/null)" || fail "create a verified backup in the Upgrade Readiness wizard first"
IFS=$'\t' read -r BACKUP_RELATIVE BACKUP_SHA256 BACKUP_SIZE <<< "$BACKUP_INFO"
[[ "$BACKUP_RELATIVE" == upgrade-readiness/backups/* && "$BACKUP_RELATIVE" != *".."* ]] || fail "backup relative path is invalid"
[[ "$BACKUP_SHA256" =~ ^[a-f0-9]{64}$ && "$BACKUP_SIZE" =~ ^[0-9]+$ ]] || fail "backup receipt returned invalid metadata"
HOST_BACKUP="$DATA_DIR/$BACKUP_RELATIVE"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
INSPECT_TEMP="$(mktemp /tmp/redman-container-inspect.XXXXXX)"
docker inspect "$CONTAINER" > "$INSPECT_TEMP" || { rm -f "$INSPECT_TEMP"; fail "could not capture container inspection"; }
chmod 0600 "$INSPECT_TEMP"
CONTAINER_IMAGE_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
CONTAINER_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"

CONTAINER_STOPPED=false
restart_on_exit() {
  exit_code=$?
  rm -f "${INSPECT_TEMP:-}"
  rm -f "${TEMP_RECEIPT:-}"
  if $CONTAINER_STOPPED; then
    docker start "$CONTAINER" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap restart_on_exit EXIT
docker stop -t 30 "$CONTAINER" >/dev/null || fail "could not stop the bridge container for maintenance"
CONTAINER_STOPPED=true

[[ -d "$READINESS_DIR" && ! -L "$READINESS_DIR" ]] || fail "upgrade-readiness must be a real directory inside app-data"
[[ "$(readlink -e -- "$READINESS_DIR")" == "$READINESS_DIR" ]] || fail "upgrade-readiness resolves outside canonical app-data"
[[ -d "$BACKUPS_DIR" && ! -L "$BACKUPS_DIR" ]] || fail "upgrade backup directory is missing or symlinked"
[[ "$(readlink -e -- "$BACKUPS_DIR")" == "$BACKUPS_DIR" ]] || fail "upgrade backup directory resolves unexpectedly"
[[ -f "$HOST_BACKUP" && ! -L "$HOST_BACKUP" ]] || fail "receipt-bound host backup is missing or symlinked"
CANONICAL_HOST_BACKUP="$(readlink -e -- "$HOST_BACKUP")" || fail "could not resolve receipt-bound host backup"
case "$CANONICAL_HOST_BACKUP" in
  "$BACKUPS_DIR"/*) ;;
  *) fail "receipt-bound host backup resolves outside the backup directory" ;;
esac
HOST_BACKUP="$CANONICAL_HOST_BACKUP"
[[ "$(stat -c %s "$HOST_BACKUP")" == "$BACKUP_SIZE" ]] || fail "host backup size does not match the receipt"
printf '%s  %s\n' "$BACKUP_SHA256" "$HOST_BACKUP" | sha256sum -c - >/dev/null \
  || fail "host backup checksum does not match the receipt"

for managed_path in "$DATA_DIR/ssh-keys" "$DATA_DIR/ssh-keys/authorized_keys"; do
  [[ ! -L "$managed_path" ]] || fail "managed SSH path may not be a symlink: $managed_path"
done

copy_optional_artifact() {
  local relative_path=$1
  local source_path="$DATA_DIR/$relative_path"
  local destination_path="$ROLLBACK_DIR/$relative_path"
  [[ -e "$source_path" || -L "$source_path" ]] || return 0
  [[ -f "$source_path" && ! -L "$source_path" ]] || fail "optional artifact is not a regular non-symlink file: $source_path"
  local canonical_source
  canonical_source="$(readlink -e -- "$source_path")" || fail "could not resolve optional artifact: $source_path"
  case "$canonical_source" in
    "$DATA_DIR"/*) ;;
    *) fail "optional artifact resolves outside app-data: $source_path" ;;
  esac
  install -D -m 0600 "$canonical_source" "$destination_path"
}

ROLLBACK_DIR="$(mktemp -d "$READINESS_DIR/rollback-$TIMESTAMP.XXXXXX")" || fail "could not create secure rollback directory"
chmod 0700 "$ROLLBACK_DIR"
ROLLBACK_RELATIVE="upgrade-readiness/${ROLLBACK_DIR##*/}"
install -m 0600 "$INSPECT_TEMP" "$ROLLBACK_DIR/container-inspect.json"
rm -f "$INSPECT_TEMP"
install -m 0600 "$HOST_BACKUP" "$ROLLBACK_DIR/redman.db"
printf '%s  %s\n' "$BACKUP_SHA256" "$ROLLBACK_DIR/redman.db" | sha256sum -c - >/dev/null \
  || fail "rollback database copy failed checksum validation"
for item in identity.json rclone.conf .ssh/id_ed25519 .ssh/id_ed25519.pub; do
  copy_optional_artifact "$item"
done

"$INSTALLER" "${INSTALL_ARGS[@]}"

ARTIFACTS_JSON=""
separator=""
for artifact in "$ROLLBACK_DIR/container-inspect.json" "$ROLLBACK_DIR/redman.db" \
  "$ROLLBACK_DIR/identity.json" "$ROLLBACK_DIR/rclone.conf" \
  "$ROLLBACK_DIR/.ssh/id_ed25519" "$ROLLBACK_DIR/.ssh/id_ed25519.pub"; do
  [[ -f "$artifact" ]] || continue
  relative_artifact="$ROLLBACK_RELATIVE/${artifact#"$ROLLBACK_DIR/"}"
  artifact_sha="$(sha256sum "$artifact" | awk '{print $1}')"
  artifact_size="$(stat -c %s "$artifact")"
  ARTIFACTS_JSON+="$separator{\"relativePath\":\"$relative_artifact\",\"sha256\":\"$artifact_sha\",\"sizeBytes\":$artifact_size}"
  separator=','
done

RECEIPT="$READINESS_DIR/host-prepared.json"
[[ ! -L "$RECEIPT" ]] || fail "host receipt destination may not be a symlink: $RECEIPT"
TEMP_RECEIPT="$(mktemp "$READINESS_DIR/.host-prepared.XXXXXX")" || fail "could not create secure receipt file"
chmod 0600 "$TEMP_RECEIPT"
{
  printf '{\n'
  printf '  "bridgeVersion": %s,\n' "$BRIDGE_VERSION"
  printf '  "preparedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "platform": "%s",\n' "$PLATFORM"
  printf '  "container": "%s",\n' "$CONTAINER"
  printf '  "containerImageId": "%s",\n' "$CONTAINER_IMAGE_ID"
  printf '  "containerImageRef": "%s",\n' "$CONTAINER_IMAGE_REF"
  printf '  "user": "redman-backup",\n'
  printf '  "dataDir": "%s",\n' "$DATA_DIR"
  printf '  "authorizedKeys": "%s/ssh-keys/authorized_keys",\n' "$DATA_DIR"
  printf '  "rollbackDir": "%s",\n' "$ROLLBACK_DIR"
  printf '  "rollbackRelativePath": "%s",\n' "$ROLLBACK_RELATIVE"
  printf '  "applicationBackupSha256": "%s",\n' "$BACKUP_SHA256"
  printf '  "backupRoots": ['
  separator=""
  for root in "${BACKUP_ROOTS[@]}"; do
    [[ -n "$root" ]] || continue
    printf '%s"%s"' "$separator" "$root"
    separator=', '
  done
  printf '],\n'
  printf '  "artifacts": [%s]\n' "$ARTIFACTS_JSON"
  printf '}\n'
} > "$TEMP_RECEIPT"
[[ ! -L "$RECEIPT" ]] || fail "host receipt destination became a symlink: $RECEIPT"
mv -fT -- "$TEMP_RECEIPT" "$RECEIPT"
TEMP_RECEIPT=""

docker start "$CONTAINER" >/dev/null || fail "host preparation succeeded but the bridge container could not restart"
CONTAINER_STOPPED=false

echo "RedMan host preparation complete"
echo "  Platform: $PLATFORM"
echo "  Rollback: $ROLLBACK_DIR"
echo "  Receipt:  $RECEIPT"
echo "Return to the Upgrade Readiness wizard and refresh the assessment."
