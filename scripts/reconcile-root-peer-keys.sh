#!/usr/bin/env bash
set -euo pipefail

DATABASE=""
MANAGED_KEYS=""
ROOT_KEYS="/root/.ssh/authorized_keys"
ROLLBACK_DIR=""

usage() {
  echo "Usage: reconcile-root-peer-keys.sh --database PATH --managed-keys PATH --rollback-dir PATH [--root-keys PATH]" >&2
  exit 2
}

absolute_file_path() {
  local label=$1 value=$2
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ && "$value" != "/" ]] || { echo "$label must be a non-root absolute path" >&2; exit 2; }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database) DATABASE=${2:-}; shift 2 ;;
    --managed-keys) MANAGED_KEYS=${2:-}; shift 2 ;;
    --root-keys) ROOT_KEYS=${2:-}; shift 2 ;;
    --rollback-dir) ROLLBACK_DIR=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done

absolute_file_path --database "$DATABASE"
absolute_file_path --managed-keys "$MANAGED_KEYS"
absolute_file_path --root-keys "$ROOT_KEYS"
absolute_file_path --rollback-dir "$ROLLBACK_DIR"
[[ -f "$DATABASE" && ! -L "$DATABASE" ]] || { echo "Database is missing or unsafe" >&2; exit 1; }
[[ -f "$MANAGED_KEYS" && ! -L "$MANAGED_KEYS" ]] || { echo "Managed authorized_keys is missing or unsafe" >&2; exit 1; }
[[ -f "$ROOT_KEYS" && ! -L "$ROOT_KEYS" ]] || exit 0
lock_dir="${ROOT_KEYS}.redman.lock"
mkdir "$lock_dir" 2>/dev/null || { echo "Could not lock root authorized_keys" >&2; exit 1; }
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
original_sha256=$(sha256sum "$ROOT_KEYS" | awk '{print $1}')

work=$(mktemp -d /tmp/redman-root-key-cleanup.XXXXXX)
backup_temporary=""
replacement_temporary=""
cleanup() {
  rm -rf "$work"
  [[ -z "$backup_temporary" ]] || rm -f "$backup_temporary"
  [[ -z "$replacement_temporary" ]] || rm -f "$replacement_temporary"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
sqlite3 -readonly "$DATABASE" "SELECT ssh_public_key FROM authorized_peers WHERE enabled = 1 AND ssh_public_key IS NOT NULL ORDER BY id LIMIT 100;" > "$work/peer-keys"
: > "$work/key-blobs"
while IFS= read -r line; do
  set -- $line
  [[ ${1:-} =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$ ]]
  [[ ${2:-} =~ ^[A-Za-z0-9+/]+={0,2}$ ]]
  printf '%s %s\n' "$1" "$2" >> "$work/key-blobs"
done < "$work/peer-keys"
[[ -s "$work/key-blobs" ]] || exit 0

while read -r key_type key_blob; do
  awk -v type="$key_type" -v blob="$key_blob" '
    { for (field_index = 1; field_index < NF; field_index++) if ($field_index == type && $(field_index + 1) == blob) found=1 }
    END { exit !found }
  ' "$MANAGED_KEYS" || { echo "Peer key was not reconciled into restricted authorized_keys" >&2; exit 1; }
done < "$work/key-blobs"

awk '
  NR == FNR { peer[$1 " " $2]=1; next }
  {
    remove=0
    for (field_index = 1; field_index < NF; field_index++) if (peer[$field_index " " $(field_index + 1)]) { remove=1; break }
    if (!remove) print
  }
' "$work/key-blobs" "$ROOT_KEYS" > "$work/authorized_keys"
cmp -s "$ROOT_KEYS" "$work/authorized_keys" && exit 0

install -d -m 0700 "$ROLLBACK_DIR"
backup_temporary=$(mktemp "$ROLLBACK_DIR/.root-authorized_keys.XXXXXX")
backup="$ROLLBACK_DIR/root-authorized_keys-$(date -u +%Y%m%dT%H%M%SZ)-${backup_temporary##*.}"
install -m 0600 "$ROOT_KEYS" "$backup_temporary"
replacement_temporary=$(mktemp "$(dirname "$ROOT_KEYS")/.authorized_keys.XXXXXX")
install -m 0600 "$work/authorized_keys" "$replacement_temporary"
current_sha256=$(sha256sum "$ROOT_KEYS" | awk '{print $1}')
[[ "$current_sha256" == "$original_sha256" ]] || { echo "Root authorized_keys changed during reconciliation" >&2; exit 1; }
mv -f "$replacement_temporary" "$ROOT_KEYS"
replacement_temporary=""
mv -f "$backup_temporary" "$backup"
backup_temporary=""