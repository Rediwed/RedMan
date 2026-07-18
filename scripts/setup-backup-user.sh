#!/usr/bin/env bash
set -euo pipefail

BACKUP_USER="redman-backup"
BACKUP_GROUP="redman-backup"
DATA_DIR=""
HOME_DIR=""
AUTHORIZED_KEYS=""
SSHD_CONFIG="/etc/ssh/sshd_config"
RRSYNC_SOURCE=""
RRSYNC_PATH="/usr/local/bin/rrsync"
AUTHORIZED_KEYS_COMMAND=""
DRY_RUN=false
SKIP_RELOAD=false
BACKUP_ROOTS=("")
SUPPLEMENTARY_GROUPS=("")

usage() {
  cat <<'EOF'
Usage: setup-backup-user.sh --data-dir PATH [options]

Creates an unprivileged OpenSSH account used only through per-key forced rrsync
commands. Generic Linux account and SSH configuration persist normally; Unraid
users should invoke setup-unraid-backup-user.sh for boot persistence.

Options:
  --data-dir PATH          RedMan host data directory (required)
  --user NAME              Backup account name (default: redman-backup)
  --group NAME             Dedicated group name (default: redman-backup)
  --home-dir PATH          Account home (default: /var/lib/USER)
  --authorized-keys PATH   Managed key file (default: DATA/ssh-keys/authorized_keys)
  --sshd-config PATH       OpenSSH server config (default: /etc/ssh/sshd_config)
  --rrsync-source PATH     Existing rrsync helper; auto-detected by default
  --rrsync-path PATH       Installed helper path (default: /usr/local/bin/rrsync)
  --authorized-keys-command PATH
                           Root-installed reader (default: /usr/local/libexec/redman-authorized-keys-USER)
  --backup-root PATH       Host backup root the account must access (repeatable)
  --supplementary-group G  Existing host group to join (repeatable)
  --skip-reload            Validate sshd config but let the operator reload it
  --dry-run                Print the resolved plan without changing the host
  --help                    Show this help
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

usage_error() {
  echo "Error: $*" >&2
  usage >&2
  exit 2
}

require_name() {
  local label=$1
  local value=$2
  [[ "$value" =~ ^[a-z_][a-z0-9_-]*$ ]] || usage_error "$label must be a lowercase system account name"
}

require_absolute_path() {
  local label=$1
  local value=$2
  [[ "$value" == /* ]] || usage_error "$label must be an absolute path"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || usage_error "$label may contain only letters, digits, dot, underscore, dash, and slash"
  [[ "/$value/" != *"/../"* ]] || usage_error "$label may not contain .. path components"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --user) BACKUP_USER="${2:-}"; shift 2 ;;
    --group) BACKUP_GROUP="${2:-}"; shift 2 ;;
    --home-dir) HOME_DIR="${2:-}"; shift 2 ;;
    --authorized-keys) AUTHORIZED_KEYS="${2:-}"; shift 2 ;;
    --sshd-config) SSHD_CONFIG="${2:-}"; shift 2 ;;
    --rrsync-source) RRSYNC_SOURCE="${2:-}"; shift 2 ;;
    --rrsync-path) RRSYNC_PATH="${2:-}"; shift 2 ;;
    --authorized-keys-command) AUTHORIZED_KEYS_COMMAND="${2:-}"; shift 2 ;;
    --backup-root) BACKUP_ROOTS+=("${2:-}"); shift 2 ;;
    --supplementary-group) SUPPLEMENTARY_GROUPS+=("${2:-}"); shift 2 ;;
    --skip-reload) SKIP_RELOAD=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage_error "unknown option: $1" ;;
  esac
done

[[ -n "$DATA_DIR" ]] || usage_error "--data-dir is required"
HOME_DIR="${HOME_DIR:-/var/lib/$BACKUP_USER}"
AUTHORIZED_KEYS="${AUTHORIZED_KEYS:-$DATA_DIR/ssh-keys/authorized_keys}"
AUTHORIZED_KEYS_COMMAND="${AUTHORIZED_KEYS_COMMAND:-/usr/local/libexec/redman-authorized-keys-$BACKUP_USER}"

require_name "--user" "$BACKUP_USER"
require_name "--group" "$BACKUP_GROUP"
require_absolute_path "--data-dir" "$DATA_DIR"
require_absolute_path "--home-dir" "$HOME_DIR"
require_absolute_path "--authorized-keys" "$AUTHORIZED_KEYS"
require_absolute_path "--sshd-config" "$SSHD_CONFIG"
require_absolute_path "--rrsync-path" "$RRSYNC_PATH"
require_absolute_path "--authorized-keys-command" "$AUTHORIZED_KEYS_COMMAND"
if [[ -n "$RRSYNC_SOURCE" ]]; then
  require_absolute_path "--rrsync-source" "$RRSYNC_SOURCE"
fi
for root in "${BACKUP_ROOTS[@]}"; do
  [[ -n "$root" ]] || continue
  require_absolute_path "--backup-root" "$root"
  [[ "$root" != "/" ]] || usage_error "--backup-root may not be the filesystem root"
done
for group in "${SUPPLEMENTARY_GROUPS[@]}"; do
  [[ -n "$group" ]] || continue
  require_name "--supplementary-group" "$group"
done
[[ "$AUTHORIZED_KEYS" == "$DATA_DIR"/* ]] || usage_error "--authorized-keys must be below --data-dir"
[[ "$BACKUP_USER" != "root" && "$BACKUP_GROUP" != "root" ]] || usage_error "the backup account may not be root"

if $DRY_RUN; then
  printf '%s\n' \
    "BACKUP_USER=$BACKUP_USER" \
    "BACKUP_GROUP=$BACKUP_GROUP" \
    "DATA_DIR=$DATA_DIR" \
    "HOME_DIR=$HOME_DIR" \
    "AUTHORIZED_KEYS=$AUTHORIZED_KEYS" \
    "AUTHORIZED_KEYS_COMMAND=$AUTHORIZED_KEYS_COMMAND" \
    "SSHD_CONFIG=$SSHD_CONFIG" \
    "RRSYNC_SOURCE=${RRSYNC_SOURCE:-auto}" \
    "RRSYNC_PATH=$RRSYNC_PATH" \
    "RELOAD=$([[ "$SKIP_RELOAD" == true ]] && echo operator || echo auto)"
  for root in "${BACKUP_ROOTS[@]}"; do [[ -n "$root" ]] && echo "BACKUP_ROOT=$root"; done
  for group in "${SUPPLEMENTARY_GROUPS[@]}"; do [[ -n "$group" ]] && echo "SUPPLEMENTARY_GROUP=$group"; done
  exit 0
fi

[[ $(id -u) -eq 0 ]] || die "run as root (for example: sudo $0 ...)"
[[ -f "$SSHD_CONFIG" ]] || die "OpenSSH config not found: $SSHD_CONFIG"

group_exists() {
  if command -v getent >/dev/null 2>&1; then
    getent group "$BACKUP_GROUP" >/dev/null 2>&1
  else
    grep -qE "^${BACKUP_GROUP}:" /etc/group
  fi
}

create_group() {
  if command -v groupadd >/dev/null 2>&1; then
    groupadd -r "$BACKUP_GROUP" 2>/dev/null || groupadd "$BACKUP_GROUP"
  elif command -v addgroup >/dev/null 2>&1; then
    addgroup -S "$BACKUP_GROUP"
  else
    die "neither groupadd nor addgroup is available"
  fi
}

create_user() {
  if command -v useradd >/dev/null 2>&1; then
    useradd -r -M -d "$HOME_DIR" -s /bin/sh -g "$BACKUP_GROUP" "$BACKUP_USER" 2>/dev/null \
      || useradd -M -d "$HOME_DIR" -s /bin/sh -g "$BACKUP_GROUP" "$BACKUP_USER"
  elif command -v adduser >/dev/null 2>&1; then
    adduser -S -D -H -h "$HOME_DIR" -s /bin/sh -G "$BACKUP_GROUP" "$BACKUP_USER"
  else
    die "neither useradd nor adduser is available"
  fi
}

if ! group_exists; then create_group; fi
if ! id "$BACKUP_USER" >/dev/null 2>&1; then create_user; fi
[[ $(id -u "$BACKUP_USER") -ne 0 ]] || die "refusing to configure a UID 0 backup account"

if command -v usermod >/dev/null 2>&1; then
  usermod -g "$BACKUP_GROUP" -d "$HOME_DIR" -s /bin/sh "$BACKUP_USER"
fi

# OpenSSH rejects a locked account before it evaluates public keys on several
# distributions. Give the account an unknown random password only to clear the
# lock marker; the Match block below disables all password/interactive methods.
password_field=""
if command -v getent >/dev/null 2>&1; then
  password_field="$(getent shadow "$BACKUP_USER" 2>/dev/null | cut -d: -f2 || true)"
fi
if [[ -z "$password_field" || "$password_field" == '!'* || "$password_field" == '*'* ]]; then
  command -v chpasswd >/dev/null 2>&1 || die "chpasswd is required to enable public-key login for the backup account"
  random_password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s:%s\n' "$BACKUP_USER" "$random_password" | chpasswd
  unset random_password
fi

for group in "${SUPPLEMENTARY_GROUPS[@]}"; do
  [[ -n "$group" ]] || continue
  if command -v getent >/dev/null 2>&1; then
    getent group "$group" >/dev/null 2>&1 || die "supplementary group does not exist: $group"
  else
    grep -qE "^${group}:" /etc/group || die "supplementary group does not exist: $group"
  fi
  if command -v usermod >/dev/null 2>&1; then
    usermod -a -G "$group" "$BACKUP_USER"
  elif command -v addgroup >/dev/null 2>&1; then
    addgroup "$BACKUP_USER" "$group"
  else
    die "cannot add $BACKUP_USER to supplementary group $group"
  fi
done

install -d -m 0750 -o "$BACKUP_USER" -g "$BACKUP_GROUP" "$HOME_DIR"
install -d -m 0700 -o root -g root "$(dirname "$AUTHORIZED_KEYS")"
if [[ ! -e "$AUTHORIZED_KEYS" ]]; then
  install -m 0600 -o root -g root /dev/null "$AUTHORIZED_KEYS"
else
  chown root:root "$AUTHORIZED_KEYS"
  chmod 0600 "$AUTHORIZED_KEYS"
fi

account_can_access() {
  local path=$1
  local command="test -d '$path' && test -x '$path' && test -r '$path' && test -w '$path'"
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$BACKUP_USER" -- /bin/sh -c "$command"
  else
    su -s /bin/sh "$BACKUP_USER" -c "$command"
  fi
}

CANONICAL_BACKUP_ROOTS=""
for root in "${BACKUP_ROOTS[@]}"; do
  [[ -n "$root" ]] || continue
  if [[ ! -e "$root" ]]; then
    install -d -m 2770 -o root -g "$BACKUP_GROUP" "$root"
  fi
  [[ -d "$root" ]] || die "backup root is not a directory: $root"
  account_can_access "$root" || die "backup account cannot read and write $root; grant access or pass an appropriate --supplementary-group"
  canonical_root="$(readlink -f -- "$root")"
  [[ "$canonical_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "canonical backup root contains unsupported characters: $canonical_root"
  CANONICAL_BACKUP_ROOTS="${CANONICAL_BACKUP_ROOTS:+$CANONICAL_BACKUP_ROOTS:}$canonical_root"
done

install -d -m 0755 "$(dirname "$AUTHORIZED_KEYS_COMMAND")"
{
  printf '%s\n' '#!/bin/sh'
  printf "AUTHORIZED_KEYS='%s'\n" "$AUTHORIZED_KEYS"
  printf "RRSYNC_PATH='%s'\n" "$RRSYNC_PATH"
  printf "BACKUP_ROOTS='%s'\n" "$CANONICAL_BACKUP_ROOTS"
  cat <<'EOF'
awk -v rrsync="$RRSYNC_PATH" '
{
  line = $0
  quote = sprintf("%c", 39)
  marker = "command=\"" rrsync " " quote
  start = index(line, marker)
  if (!start) next
  prefix = substr(line, 1, start - 1)
  if (prefix != "restrict," && prefix !~ /^restrict,from="[0-9A-Fa-f.:%]+",$/) next
  rest = substr(line, start + length(marker))
  end_marker = quote "\" ssh-ed25519 "
  stop = index(rest, end_marker)
  if (!stop) next
  path = substr(rest, 1, stop - 1)
  tail = substr(rest, stop + length(end_marker))
  split(tail, parts, /[[:space:]]+/)
  if (path !~ /^\/[-A-Za-z0-9._\/ ]+$/ || path ~ /(^|\/)\.\.(\/|$)/) next
  if (parts[1] !~ /^[A-Za-z0-9+\/]+(=|==)?$/) next
  print path
  print line
}
' "$AUTHORIZED_KEYS" |
while IFS= read -r candidate && IFS= read -r entry; do
  resolved="$(readlink -f -- "$candidate" 2>/dev/null)" || continue
  [ -d "$resolved" ] || continue
  previous_ifs=$IFS
  IFS=:
  matched=false
  for root in $BACKUP_ROOTS; do
    case "$resolved" in
      "$root"|"$root"/*) matched=true; break ;;
    esac
  done
  IFS=$previous_ifs
  if $matched; then printf '%s\n' "$entry"; fi
done
EOF
} > "$AUTHORIZED_KEYS_COMMAND"
chown root:root "$AUTHORIZED_KEYS_COMMAND"
chmod 0755 "$AUTHORIZED_KEYS_COMMAND"

if [[ -z "$RRSYNC_SOURCE" ]]; then
  RRSYNC_SOURCE="$(command -v rrsync || true)"
  if [[ -z "$RRSYNC_SOURCE" ]]; then
    for candidate in \
      /usr/bin/rrsync \
      /usr/share/rsync/scripts/rrsync \
      /usr/share/doc/rsync/scripts/rrsync \
      /usr/share/doc/rsync/support/rrsync \
      /usr/share/doc/rsync*/support/rrsync; do
      if [[ -f "$candidate" ]]; then RRSYNC_SOURCE="$candidate"; break; fi
    done
  fi
fi
[[ -n "$RRSYNC_SOURCE" && -f "$RRSYNC_SOURCE" ]] || die "rrsync was not found; install the rsync support scripts or pass --rrsync-source"
install -d -m 0755 "$(dirname "$RRSYNC_PATH")"
if [[ ! -e "$RRSYNC_PATH" || ! "$RRSYNC_SOURCE" -ef "$RRSYNC_PATH" ]]; then
  install -m 0755 "$RRSYNC_SOURCE" "$RRSYNC_PATH"
else
  chmod 0755 "$RRSYNC_PATH"
fi

SSHD_BIN="$(command -v sshd || true)"
if [[ -z "$SSHD_BIN" ]]; then
  for candidate in /usr/sbin/sshd /usr/local/sbin/sshd; do
    if [[ -x "$candidate" ]]; then SSHD_BIN="$candidate"; break; fi
  done
fi
[[ -n "$SSHD_BIN" ]] || die "OpenSSH server (sshd) was not found"

BEGIN_MARKER="# BEGIN REDMAN BACKUP USER: $BACKUP_USER"
END_MARKER="# END REDMAN BACKUP USER: $BACKUP_USER"
ORIGINAL="$(mktemp)"
UPDATED="$(mktemp)"
ALLOW_USERS_UPDATED="$(mktemp)"
trap 'rm -f "$ORIGINAL" "$UPDATED" "$ALLOW_USERS_UPDATED"' EXIT
cp -p "$SSHD_CONFIG" "$ORIGINAL"
if [[ ! -e "$SSHD_CONFIG.redman-backup.orig" ]]; then
  cp -p "$SSHD_CONFIG" "$SSHD_CONFIG.redman-backup.orig"
fi

awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
  $0 == begin { skip = 1; next }
  $0 == end { skip = 0; next }
  !skip { print }
' "$SSHD_CONFIG" > "$UPDATED"

awk -v user="$BACKUP_USER" '
  BEGIN { in_match = 0 }
  /^[[:space:]]*Match[[:space:]]/ { in_match = 1 }
  !in_match && $1 == "AllowUsers" {
    found = 0
    for (i = 2; i <= NF; i++) if ($i == user) found = 1
    if (!found) $0 = $0 " " user
  }
  { print }
' "$UPDATED" > "$ALLOW_USERS_UPDATED"

cat >> "$ALLOW_USERS_UPDATED" <<EOF

$BEGIN_MARKER
Match User $BACKUP_USER
  AuthorizedKeysFile none
  AuthorizedKeysCommand $AUTHORIZED_KEYS_COMMAND
  AuthorizedKeysCommandUser root
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ChallengeResponseAuthentication no
    PermitTTY no
    X11Forwarding no
    AllowTcpForwarding no
    PermitTunnel no
    GatewayPorts no
$END_MARKER
EOF

cat "$ALLOW_USERS_UPDATED" > "$SSHD_CONFIG"

rollback_config() {
  cat "$ORIGINAL" > "$SSHD_CONFIG"
}

if ! "$SSHD_BIN" -t -f "$SSHD_CONFIG"; then
  rollback_config
  die "sshd rejected the generated configuration; the original was restored"
fi

reload_sshd() {
  if $SKIP_RELOAD; then return 0; fi
  if command -v systemctl >/dev/null 2>&1; then
    for unit in sshd ssh; do
      if systemctl reload "$unit" >/dev/null 2>&1; then return 0; fi
    done
  fi
  if [[ -x /etc/rc.d/rc.sshd ]] && /etc/rc.d/rc.sshd restart >/dev/null 2>&1; then return 0; fi
  if command -v service >/dev/null 2>&1; then
    for unit in sshd ssh; do
      if service "$unit" reload >/dev/null 2>&1; then return 0; fi
    done
  fi
  return 1
}

if ! reload_sshd; then
  rollback_config
  die "could not reload OpenSSH; the original configuration was restored (use --skip-reload only when SSH is reloaded externally)"
fi

echo "RedMan backup account ready: user=$BACKUP_USER keys=$AUTHORIZED_KEYS rrsync=$RRSYNC_PATH"