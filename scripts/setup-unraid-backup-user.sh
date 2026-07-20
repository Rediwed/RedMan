#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_SCRIPT="$SCRIPT_DIR/setup-backup-user.sh"
PERSIST_DIR="/boot/config/plugins/redman"
PERSIST_WRAPPER="$PERSIST_DIR/setup-unraid-backup-user.sh"
PERSIST_CORE="$PERSIST_DIR/setup-backup-user.sh"
PERSIST_RRSYNC="$PERSIST_DIR/rrsync"
GO_FILE="/boot/config/go"
DATA_DIR=""
BACKUP_USER="redman-backup"
RRSYNC_SOURCE=""
DRY_RUN=false
NO_PERSIST=false
CORE_ARGS=()
PERSIST_ARGS=()

usage() {
  cat <<'EOF'
Usage: setup-unraid-backup-user.sh --data-dir PATH [portable installer options]

Runs setup-backup-user.sh and persists both scripts through Unraid's boot hook.
Use setup-backup-user.sh directly on a normal Linux host.

Wrapper options:
  --no-persist   Configure this boot only (do not update /boot/config/go)
  --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)
      DATA_DIR="${2:-}"
      CORE_ARGS+=("$1" "$DATA_DIR")
      PERSIST_ARGS+=("$1" "$DATA_DIR")
      shift 2
      ;;
    --user)
      BACKUP_USER="${2:-}"
      CORE_ARGS+=("$1" "$BACKUP_USER")
      PERSIST_ARGS+=("$1" "$BACKUP_USER")
      shift 2
      ;;
    --rrsync-source)
      RRSYNC_SOURCE="${2:-}"
      CORE_ARGS+=("$1" "$RRSYNC_SOURCE")
      shift 2
      ;;
    --home-dir|--group|--authorized-keys|--authorized-keys-command|--sshd-config|--rrsync-path|--backup-root|--supplementary-group)
      CORE_ARGS+=("$1" "${2:-}")
      PERSIST_ARGS+=("$1" "${2:-}")
      shift 2
      ;;
    --skip-reload)
      CORE_ARGS+=("$1")
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      CORE_ARGS+=("$1")
      shift
      ;;
    --no-persist)
      NO_PERSIST=true
      shift
      ;;
    --help|-h)
      usage
      bash "$CORE_SCRIPT" --help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -f "$CORE_SCRIPT" ]] || { echo "Portable installer not found: $CORE_SCRIPT" >&2; exit 1; }
[[ -n "$DATA_DIR" ]] || { echo "--data-dir is required" >&2; exit 2; }

has_home=false
for arg in "${CORE_ARGS[@]}"; do
  if [[ "$arg" == "--home-dir" ]]; then has_home=true; break; fi
done
if ! $has_home; then
  CORE_ARGS+=(--home-dir "/home/$BACKUP_USER")
  PERSIST_ARGS+=(--home-dir "/home/$BACKUP_USER")
fi

has_users_group=false
previous_arg=""
for arg in "${CORE_ARGS[@]}"; do
  if [[ "$previous_arg" == "--supplementary-group" && "$arg" == "users" ]]; then
    has_users_group=true
    break
  fi
  previous_arg="$arg"
done
if ! $has_users_group && command -v getent >/dev/null 2>&1 && getent group users >/dev/null 2>&1; then
  CORE_ARGS+=(--supplementary-group users)
  PERSIST_ARGS+=(--supplementary-group users)
fi

if ! $DRY_RUN; then
  [[ $(id -u) -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
  if ! $NO_PERSIST; then
    [[ -f "$GO_FILE" ]] || { echo "Unraid boot file not found: $GO_FILE" >&2; exit 1; }
  fi
fi

bash "$CORE_SCRIPT" "${CORE_ARGS[@]}"
if $DRY_RUN || $NO_PERSIST; then exit 0; fi

install -d -m 0700 "$PERSIST_DIR"
if [[ "$CORE_SCRIPT" != "$PERSIST_CORE" ]]; then
  install -m 0700 "$CORE_SCRIPT" "$PERSIST_CORE"
fi
if [[ "$0" != "$PERSIST_WRAPPER" ]]; then
  install -m 0700 "$0" "$PERSIST_WRAPPER"
fi
if [[ -n "$RRSYNC_SOURCE" ]]; then
  if [[ "$RRSYNC_SOURCE" != "$PERSIST_RRSYNC" ]]; then
    install -m 0700 "$RRSYNC_SOURCE" "$PERSIST_RRSYNC"
  else
    chmod 0700 "$PERSIST_RRSYNC"
  fi
elif [[ -f /usr/local/bin/rrsync ]]; then
  install -m 0700 /usr/local/bin/rrsync "$PERSIST_RRSYNC"
fi
if [[ -f "$PERSIST_RRSYNC" ]]; then
  PERSIST_ARGS+=(--rrsync-source "$PERSIST_RRSYNC")
fi

printf -v quoted_wrapper '%q' "$PERSIST_WRAPPER"
BOOT_COMMAND="bash $quoted_wrapper"
for arg in "${PERSIST_ARGS[@]}"; do
  printf -v quoted_arg '%q' "$arg"
  BOOT_COMMAND+=" $quoted_arg"
done
UPDATED_GO="$(mktemp)"
trap 'rm -f "$UPDATED_GO"' EXIT
awk -v wrapper="$PERSIST_WRAPPER" -v legacy="$PERSIST_CORE" '
  index($0, wrapper " ") != 1 && $0 != wrapper \
    && index($0, "bash " wrapper " ") != 1 && $0 != "bash " wrapper \
    && index($0, legacy " ") != 1 && $0 != legacy \
    && index($0, "bash " legacy " ") != 1 && $0 != "bash " legacy
' "$GO_FILE" > "$UPDATED_GO"
cat "$UPDATED_GO" > "$GO_FILE"
printf '\n%s\n' "$BOOT_COMMAND" >> "$GO_FILE"

echo "RedMan Unraid persistence ready: $BOOT_COMMAND"