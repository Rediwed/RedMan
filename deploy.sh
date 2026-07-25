#!/bin/bash
# Deploy RedMan to configured Linux/Unraid instances
#
# Usage:
#   ./deploy.sh --custom            # Deploy an environment-configured public target
#   ./deploy.sh --profile NAME      # Deploy an optional local named profile
#   ./deploy.sh --seed              # Reseed database after deploy
#   ./deploy.sh --test              # Include test/ directory
#   ./deploy.sh --force             # Skip activity check, stop active jobs gracefully
#   ./deploy.sh --check             # Only check for active jobs, don't deploy
#   ./deploy.sh --clear-breakglass-latch # Explicitly clear a persistent safety latch
#
# The script refuses to deploy if there are active backup/import jobs running,
# unless --force is used (which gracefully stops them first).
# Existing containers preserve auth/trust values when a target leaves them unset.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Target definitions ──
PROFILE_FILE="${REDMAN_DEPLOY_PROFILE_FILE:-$SCRIPT_DIR/.redman-deploy-profiles.sh}"
if [[ -f "$PROFILE_FILE" ]]; then
  # Profiles are local operator configuration and intentionally gitignored.
  # shellcheck source=/dev/null
  source "$PROFILE_FILE"
fi

target_config() {
  T_SSH=""
  T_SRC=""
  T_DATA=""
  T_PORT=""
  T_WEB_BIND=""
  T_PEER_API_PORT=""
  T_PEER_BIND=""
  T_DOCKER=""
  T_AUTH_MODE=""
  T_PUBLIC_ORIGIN=""
  T_TRUSTED_PROXIES=""
  T_PEER_HOST=""
  T_AUTO_PROVISION_ROLE=""
  T_BOOTSTRAP_TOKEN=""
  T_STORAGE_PATH=""
  T_MEDIA_PATH=""
  T_PLATFORM=""
  T_TZ=""
  T_DOCKER_MONITORING=""
  T_BACKUP_ROOT_ARGS=""
  T_EXTRA_VOLS=""
  T_STORAGE_ROOTS=""
  T_MEDIA_ROOT=""
  T_SETUP_SCRIPT=""
  T_SHARE_CONFIG_DIR=""

  case "$1" in
    custom)
      T_SSH="${REDMAN_DEPLOY_SSH:-}"
      T_SRC="${REDMAN_DEPLOY_SOURCE_PATH:-}"
      T_DATA="${REDMAN_DEPLOY_DATA_PATH:-}"
      T_PORT="${REDMAN_DEPLOY_WEB_PORT:-8090}"
      T_WEB_BIND="${REDMAN_DEPLOY_WEB_BIND:-127.0.0.1}"
      T_PEER_API_PORT="${REDMAN_DEPLOY_PEER_PORT:-8091}"
      T_PEER_BIND="${REDMAN_DEPLOY_PEER_BIND:-}"
      T_DOCKER="${REDMAN_DEPLOY_DOCKER_PREFIX:-}"
      T_AUTH_MODE="${REDMAN_DEPLOY_AUTH_MODE:-}"
      T_PUBLIC_ORIGIN="${REDMAN_DEPLOY_PUBLIC_ORIGIN:-}"
      T_TRUSTED_PROXIES="${REDMAN_DEPLOY_TRUSTED_PROXIES:-}"
      T_PEER_HOST="${REDMAN_DEPLOY_PEER_HOST:-}"
      T_AUTO_PROVISION_ROLE="${REDMAN_DEPLOY_AUTO_PROVISION_ROLE:-}"
      T_BOOTSTRAP_TOKEN="${REDMAN_DEPLOY_BOOTSTRAP_TOKEN:-}"
      T_STORAGE_PATH="${REDMAN_DEPLOY_STORAGE_PATH:-}"
      T_MEDIA_PATH="${REDMAN_DEPLOY_MEDIA_PATH:-}"
      T_PLATFORM="${REDMAN_DEPLOY_PLATFORM:-linux}"
      T_TZ="${REDMAN_DEPLOY_TZ:-UTC}"
      T_DOCKER_MONITORING="${REDMAN_DEPLOY_DOCKER_MONITORING:-false}"
      T_BACKUP_ROOT_ARGS="--backup-root $T_STORAGE_PATH --backup-root $T_MEDIA_PATH"
      T_EXTRA_VOLS="-v $T_STORAGE_PATH:$T_STORAGE_PATH -v $T_MEDIA_PATH:$T_MEDIA_PATH -v $T_DATA/ssh-keys/authorized_keys:/host-ssh/authorized_keys"
      T_STORAGE_ROOTS="$T_STORAGE_PATH,$T_MEDIA_PATH"
      T_MEDIA_ROOT="$T_MEDIA_PATH"
      if [[ "$T_PLATFORM" == "unraid" ]]; then
        T_SETUP_SCRIPT="setup-unraid-backup-user.sh"
        T_SHARE_CONFIG_DIR="/boot/config/shares"
        T_EXTRA_VOLS="-v /boot/config/shares:/boot/config/shares:ro $T_EXTRA_VOLS"
      else
        T_SETUP_SCRIPT="setup-backup-user.sh"
        T_SHARE_CONFIG_DIR=""
      fi
      ;;
    *)
      if declare -F redman_deploy_profile >/dev/null 2>&1 && redman_deploy_profile "$1"; then
        T_WEB_BIND="${T_WEB_BIND:-127.0.0.1}"
        T_PEER_BIND="${T_PEER_BIND:-$T_PEER_HOST}"
        return 0
      fi
      echo -e "${RED}Unknown target profile: $1${NC}"
      return 1
      ;;
  esac
}

CONTAINER="redman"
DOCKER_READ_PROXY_CONTAINER="redman-docker-socket-proxy"
DOCKER_CONTROL_PROXY_CONTAINER="redman-docker-control-proxy"
DOCKER_PROXY_IMAGE="redman-docker-api-proxy"
DOCKER_NETWORK="redman-docker-api"
BREAKGLASS_TOOL="/usr/local/sbin/container-breakglass"
DEPLOY_GUARD_TOOL="/usr/local/sbin/container-deploy-guard"
BREAKGLASS_PLUGIN="/boot/config/plugins/container-breakglass.plg"
DEPLOY_GUARD_SECONDS="${REDMAN_DEPLOY_GUARD_SECONDS:-600}"
HEALTH_TIMEOUT_SECONDS="${REDMAN_DEPLOY_HEALTH_TIMEOUT_SECONDS:-120}"
OBSERVATION_SECONDS="${REDMAN_DEPLOY_OBSERVATION_SECONDS:-120}"
MIN_AVAILABLE_MEMORY_KB="${REDMAN_DEPLOY_MIN_AVAILABLE_MEMORY_KB:-524288}"
MIN_DOCKER_FREE_KB="${REDMAN_DEPLOY_MIN_DOCKER_FREE_KB:-2097152}"
BUILD_TIMEOUT_SECONDS="${REDMAN_DEPLOY_BUILD_TIMEOUT_SECONDS:-900}"
SETUP_TIMEOUT_SECONDS="${REDMAN_DEPLOY_SETUP_TIMEOUT_SECONDS:-300}"

# ── Parse args ──
DEPLOY_TARGETS=()
DO_SEED=false
INCLUDE_TEST=false
FORCE=false
CHECK_ONLY=false
PRINT_CONFIG=false
CLEAR_BREAKGLASS_LATCH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --custom)     DEPLOY_TARGETS+=(custom); shift ;;
    --profile)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--profile requires a name" >&2; exit 2; }
      DEPLOY_TARGETS+=("$2")
      shift 2
      ;;
    --seed)       DO_SEED=true; shift ;;
    --test)       INCLUDE_TEST=true; shift ;;
    --force)      FORCE=true; shift ;;
    --check)      CHECK_ONLY=true; shift ;;
    --print-config) PRINT_CONFIG=true; shift ;;
    --clear-breakglass-latch) CLEAR_BREAKGLASS_LATCH=true; shift ;;
    --help|-h)
      echo "Usage: ./deploy.sh --custom|--profile NAME [--profile NAME ...] [--seed] [--test] [--force] [--check] [--print-config] [--clear-breakglass-latch]"
      echo ""
      echo "  --custom      Deploy using REDMAN_DEPLOY_* environment variables"
      echo "  --profile N   Deploy a profile from .redman-deploy-profiles.sh (repeatable)"
      echo "  --seed        Reseed database after deploy (destructive!)"
      echo "  --test        Include test/ directory in sync"
      echo "  --force       Skip activity check and gracefully stop active jobs"
      echo "  --check       Only check for active jobs, don't deploy"
      echo "  --print-config Validate and print non-secret target settings, then exit"
      echo "  --clear-breakglass-latch Explicitly clear the target's persistent safety latch"
      echo ""
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC} (use --help)"
      exit 1
      ;;
  esac
done

# Never default to a deployment host in public software.
if [[ ${#DEPLOY_TARGETS[@]} -eq 0 ]]; then
  echo -e "${RED}Choose --custom or --profile NAME (use --help).${NC}"
  exit 2
fi

validate_target_config() {
  local target=$1
  target_config "$target"
  [[ "$T_SSH" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "Invalid or missing SSH target for $target" >&2; return 1; }
  for path in "$T_SRC" "$T_DATA"; do
    [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "Invalid or missing deployment path for $target: $path" >&2; return 1; }
  done
  [[ "$T_PORT" =~ ^[0-9]+$ && "$T_PEER_API_PORT" =~ ^[0-9]+$ ]] || { echo "Invalid published ports for $target" >&2; return 1; }
  if [[ "$T_WEB_BIND" != "127.0.0.1" ]]; then
    local web_first web_second web_third web_fourth web_octet
    IFS=. read -r web_first web_second web_third web_fourth <<< "$T_WEB_BIND"
    for web_octet in "$web_first" "$web_second" "$web_third" "$web_fourth"; do
      [[ "$web_octet" =~ ^[0-9]{1,3}$ ]] && (( 10#$web_octet <= 255 )) \
        || { echo "Invalid web bind for $target; use 127.0.0.1 or a private IPv4 address" >&2; return 1; }
    done
    web_first=$((10#$web_first)); web_second=$((10#$web_second))
    (( web_first == 10 \
      || (web_first == 172 && web_second >= 16 && web_second <= 31) \
      || (web_first == 192 && web_second == 168) \
      || (web_first == 100 && web_second >= 64 && web_second <= 127) )) \
      || { echo "Web bind must be loopback, private RFC1918, or CGNAT IPv4 for $target" >&2; return 1; }
  fi
  local first second third fourth octet
  IFS=. read -r first second third fourth <<< "$T_PEER_BIND"
  for octet in "$first" "$second" "$third" "$fourth"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && (( 10#$octet <= 255 )) \
      || { echo "Invalid or missing private IPv4 peer bind for $target" >&2; return 1; }
  done
  first=$((10#$first)); second=$((10#$second)); third=$((10#$third)); fourth=$((10#$fourth))
  (( first == 10 \
    || (first == 172 && second >= 16 && second <= 31) \
    || (first == 192 && second == 168) \
    || (first == 100 && second >= 64 && second <= 127) )) \
    || { echo "Peer bind must be a private RFC1918 or CGNAT IPv4 address for $target" >&2; return 1; }
  [[ "$T_DOCKER" == "" || "$T_DOCKER" == "sudo" ]] || { echo "Docker prefix must be empty or sudo" >&2; return 1; }
  [[ "$T_SETUP_SCRIPT" == "setup-backup-user.sh" || "$T_SETUP_SCRIPT" == "setup-unraid-backup-user.sh" ]] || return 1
  [[ "$T_DOCKER_MONITORING" == "true" || "$T_DOCKER_MONITORING" == "false" ]] || { echo "Docker monitoring must be true or false" >&2; return 1; }
  [[ "$T_TZ" =~ ^(UTC|[A-Za-z][A-Za-z0-9._+-]*/[A-Za-z0-9._+/-]+)$ ]] || { echo "Invalid timezone for $target; use UTC or an IANA zone such as Europe/Amsterdam" >&2; return 1; }
  if [[ "$target" == "custom" ]]; then
    [[ "$T_PLATFORM" == "linux" || "$T_PLATFORM" == "unraid" ]] || { echo "REDMAN_DEPLOY_PLATFORM must be linux or unraid" >&2; return 1; }
    for path in "$T_STORAGE_PATH" "$T_MEDIA_PATH"; do
      [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ && "$path" != "/" ]] || { echo "Invalid or missing custom storage/media path: $path" >&2; return 1; }
    done
  fi
}

for target in "${DEPLOY_TARGETS[@]}"; do
  validate_target_config "$target" || exit 2
done

[[ "$DEPLOY_GUARD_SECONDS" =~ ^[0-9]+$ && "$DEPLOY_GUARD_SECONDS" -ge 180 && "$DEPLOY_GUARD_SECONDS" -le 1800 ]] \
  || { echo "REDMAN_DEPLOY_GUARD_SECONDS must be 180-1800" >&2; exit 2; }
[[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$HEALTH_TIMEOUT_SECONDS" -ge 20 && "$HEALTH_TIMEOUT_SECONDS" -le 900 ]] \
  || { echo "REDMAN_DEPLOY_HEALTH_TIMEOUT_SECONDS must be 20-900" >&2; exit 2; }
[[ "$OBSERVATION_SECONDS" =~ ^[0-9]+$ && "$OBSERVATION_SECONDS" -ge 30 && "$OBSERVATION_SECONDS" -le 900 ]] \
  || { echo "REDMAN_DEPLOY_OBSERVATION_SECONDS must be 30-900" >&2; exit 2; }
[[ "$MIN_AVAILABLE_MEMORY_KB" =~ ^[1-9][0-9]*$ ]] \
  || { echo "Invalid REDMAN_DEPLOY_MIN_AVAILABLE_MEMORY_KB" >&2; exit 2; }
[[ "$MIN_DOCKER_FREE_KB" =~ ^[1-9][0-9]*$ ]] \
  || { echo "Invalid REDMAN_DEPLOY_MIN_DOCKER_FREE_KB" >&2; exit 2; }
[[ "$BUILD_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$BUILD_TIMEOUT_SECONDS" -ge 60 && "$BUILD_TIMEOUT_SECONDS" -le 1800 ]] \
  || { echo "REDMAN_DEPLOY_BUILD_TIMEOUT_SECONDS must be 60-1800" >&2; exit 2; }
[[ "$SETUP_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$SETUP_TIMEOUT_SECONDS" -ge 30 && "$SETUP_TIMEOUT_SECONDS" -le 900 ]] \
  || { echo "REDMAN_DEPLOY_SETUP_TIMEOUT_SECONDS must be 30-900" >&2; exit 2; }
(( DEPLOY_GUARD_SECONDS >= HEALTH_TIMEOUT_SECONDS + OBSERVATION_SECONDS + 60 )) \
  || { echo "Deployment guard must cover startup, observation, and a 60-second margin" >&2; exit 2; }

if $PRINT_CONFIG; then
  for target in "${DEPLOY_TARGETS[@]}"; do
    target_config "$target"
    printf '%s\n' \
      "TARGET=$target" \
      "SSH=$T_SSH" \
      "SOURCE=$T_SRC" \
      "DATA=$T_DATA" \
      "WEB_BIND=$T_WEB_BIND" \
      "WEB_PORT=$T_PORT" \
      "PEER_PORT=$T_PEER_API_PORT" \
      "PEER_BIND=$T_PEER_BIND" \
      "SETUP_SCRIPT=$T_SETUP_SCRIPT" \
      "STORAGE_ROOTS=$T_STORAGE_ROOTS" \
      "MEDIA_ROOT=$T_MEDIA_ROOT" \
      "SHARE_CONFIG_DIR=$T_SHARE_CONFIG_DIR" \
      "DOCKER_MONITORING=$T_DOCKER_MONITORING" \
      "RUNTIME_LIMITS=preserve-existing-container-or-DockerMan" \
      "MIN_DOCKER_FREE_KB=$MIN_DOCKER_FREE_KB" \
      "BUILD_TIMEOUT_SECONDS=$BUILD_TIMEOUT_SECONDS" \
      "SETUP_TIMEOUT_SECONDS=$SETUP_TIMEOUT_SECONDS" \
      "DEPLOY_GUARD_SECONDS=$DEPLOY_GUARD_SECONDS" \
      "HEALTH_TIMEOUT_SECONDS=$HEALTH_TIMEOUT_SECONDS" \
      "OBSERVATION_SECONDS=$OBSERVATION_SECONDS" \
      "TZ=$T_TZ"
  done
  exit 0
fi

# ── Pre-deploy checks ──
echo -e "${CYAN}Running pre-deploy checks...${NC}"

SYNTAX_OK=true
for f in app/backend/src/index.js app/backend/src/peerApi.js app/backend/src/db.js app/backend/src/migrations.js app/backend/src/seed.js; do
  if ! node --check "$f" 2>/dev/null; then
    echo -e "${RED}  Syntax error in $f${NC}"
    SYNTAX_OK=false
  fi
done
for f in app/backend/src/routes/*.js app/backend/src/services/*.js; do
  if ! node --check "$f" 2>/dev/null; then
    echo -e "${RED}  Syntax error in $f${NC}"
    SYNTAX_OK=false
  fi
done

if ! $SYNTAX_OK; then
  echo -e "${RED}${BOLD}🚫 Deploy blocked — fix syntax errors above${NC}"
  exit 1
fi

if node test/test_backward_compat.mjs --skip-live 2>&1 | grep -q "0 failed"; then
  echo -e "${GREEN}✅ Syntax + backward compat OK${NC}"
else
  echo -e "${RED}${BOLD}🚫 Deploy blocked — backward compatibility check failed${NC}"
  node test/test_backward_compat.mjs --skip-live 2>&1 | tail -5
  exit 1
fi

# ── Rsync excludes ──
RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='.git'
  --exclude='app/backend/data/'
  --exclude='.env*'
  --exclude='*.pem'
  --exclude='*.key'
  --exclude='id_rsa*'
  --exclude='id_ed25519*'
  --exclude='.npmrc'
  --exclude='.netrc'
  --exclude='.redman-deploy-profiles.sh'
  --exclude='.redman-release.env'
  --exclude='*.db'
  --exclude='*.db-wal'
  --exclude='*.db-shm'
  --exclude='.DS_Store'
)
if ! $INCLUDE_TEST; then
  RSYNC_EXCLUDES+=(--exclude='test/')
fi

# ── Activity check ──
# Queries the running RedMan instance for active jobs before deploying.
# Returns 0 if safe, 1 if busy.
check_activity() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local docker_prefix="$T_DOCKER"

  echo -e "  ${CYAN}Checking for active jobs on ${target}...${NC}"

  # Check if container is running
  local running
  if ! running=$(ssh -o ConnectTimeout=5 "$ssh_host" "${docker_prefix} docker ps -q -f name=$CONTAINER" 2>/dev/null); then
    echo -e "  ${RED}Cannot verify container state — deployment is unsafe without --force${NC}"
    return 1
  fi
  if [[ -z "$running" ]]; then
    echo -e "  ${YELLOW}Container not running — safe to deploy${NC}"
    return 0
  fi

  local active_jobs
  if ! active_jobs=$(ssh -o ConnectTimeout=5 "$ssh_host" \
    "${docker_prefix} docker exec $CONTAINER node --input-type=module -e \"
      import Database from 'better-sqlite3';
      const db = new Database('/app/backend/data/redman.db', { readonly: true });
      const row = db.prepare(\\\"SELECT COUNT(*) AS count FROM backup_runs WHERE status = 'running'\\\").get();
      process.stdout.write(String(row.count));
      db.close();
    \"" 2>/dev/null); then
    echo -e "  ${RED}Cannot query active jobs inside the container — deployment is unsafe without --force${NC}"
    return 1
  fi
  if [[ ! "$active_jobs" =~ ^[0-9]+$ ]]; then
    echo -e "  ${RED}Active job query returned invalid data — refusing deployment${NC}"
    return 1
  fi

  if [[ "$active_jobs" == "0" ]]; then
    echo -e "  ${GREEN}No active jobs${NC}"
    return 0
  fi

  # There are active jobs — get details
  echo -e "  ${RED}⚠️  ${active_jobs} active job(s) running!${NC}"

  # List running jobs from backup_runs
  local running_jobs
  running_jobs=$(ssh -o ConnectTimeout=5 "$ssh_host" \
    "${docker_prefix} docker exec $CONTAINER node -e \"
      const Database = (await import('better-sqlite3')).default;
      const db = new Database('/app/backend/data/redman.db', { readonly: true });
      const runs = db.prepare(\\\"SELECT id, feature, config_id, started_at FROM backup_runs WHERE status = 'running'\\\").all();
      runs.forEach(r => console.log('    ' + r.feature + ' run #' + r.id + ' (started ' + r.started_at + ')'));
      if (!runs.length) console.log('    (no running jobs in DB — may be in-memory only)');
      db.close();
    \"" 2>/dev/null) || true

  if [[ -n "$running_jobs" ]]; then
    echo "$running_jobs"
  fi

  return 1
}

# Gracefully stop active jobs via SIGTERM (triggers RedMan's shutdown handler)
graceful_stop() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local docker_prefix="$T_DOCKER"

  echo -e "  ${YELLOW}Gracefully stopping RedMan on ${target}...${NC}"
  ssh "$ssh_host" "${docker_prefix} docker stop -t 30 $CONTAINER" 2>/dev/null || true
  echo -e "  ${GREEN}Stopped${NC}"
}

capture_rollback_metadata() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local docker_prefix="$T_DOCKER"

  ssh -o ConnectTimeout=8 "$ssh_host" "set -e; umask 077; \
    if ${docker_prefix} docker inspect $CONTAINER >/dev/null 2>&1; then \
      timestamp=\$(date -u +%Y%m%dT%H%M%SZ); \
      rollback_dir='$T_DATA/deploy-rollback'; \
      ${docker_prefix} install -d -m 0700 \"\$rollback_dir\"; \
      temporary=\$(${docker_prefix} mktemp \"\$rollback_dir/.container-\$timestamp.XXXXXX\"); \
      ${docker_prefix} docker inspect $CONTAINER | ${docker_prefix} tee \"\$temporary\" >/dev/null; \
      ${docker_prefix} chmod 0600 \"\$temporary\"; \
      ${docker_prefix} mv -f \"\$temporary\" \"\$rollback_dir/container-\$timestamp.json\"; \
      image_id=\$(${docker_prefix} docker inspect -f '{{.Image}}' $CONTAINER); \
      ${docker_prefix} docker image tag \"\$image_id\" '$CONTAINER:rollback-'\"\$timestamp\"; \
    fi"
}

capture_current_runtime_receipt() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local docker_prefix="$T_DOCKER"

  ssh -o ConnectTimeout=8 "$ssh_host" "set -e; umask 077; \
    receipt_dir='$T_DATA/deploy-current'; \
    ${docker_prefix} install -d -m 0700 \"\$receipt_dir\"; \
    temporary=\$(${docker_prefix} mktemp \"\$receipt_dir/.container-runtime.XXXXXX\"); \
    image_ref=\$(${docker_prefix} docker inspect -f '{{.Config.Image}}' $CONTAINER); \
    image_id=\$(${docker_prefix} docker inspect -f '{{.Image}}' $CONTAINER); \
    runtime=\$(${docker_prefix} docker inspect -f '{\"memory\":{{json .HostConfig.Memory}},\"memorySwap\":{{json .HostConfig.MemorySwap}},\"nanoCpus\":{{json .HostConfig.NanoCpus}},\"pidsLimit\":{{json .HostConfig.PidsLimit}},\"cpusetCpus\":{{json .HostConfig.CpusetCpus}},\"cpuShares\":{{json .HostConfig.CpuShares}},\"restartPolicy\":{{json .HostConfig.RestartPolicy}},\"readonlyRootfs\":{{json .HostConfig.ReadonlyRootfs}},\"securityOpt\":{{json .HostConfig.SecurityOpt}},\"capAdd\":{{json .HostConfig.CapAdd}},\"capDrop\":{{json .HostConfig.CapDrop}},\"networkMode\":{{json .HostConfig.NetworkMode}},\"binds\":{{json .HostConfig.Binds}},\"portBindings\":{{json .HostConfig.PortBindings}}}' $CONTAINER); \
    printf '{\"version\":1,\"capturedAt\":\"%s\",\"container\":\"$CONTAINER\",\"imageRef\":\"%s\",\"imageId\":\"%s\",\"runtime\":%s}\n' \
      \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \"\$image_ref\" \"\$image_id\" \"\$runtime\" | ${docker_prefix} tee \"\$temporary\" >/dev/null; \
    ${docker_prefix} chmod 0600 \"\$temporary\"; \
    ${docker_prefix} mv -f \"\$temporary\" \"\$receipt_dir/container-runtime.json\""
}

remove_reconciled_root_peer_keys() {
  local target=$1
  target_config "$target"
  [[ "$T_SETUP_SCRIPT" == "setup-unraid-backup-user.sh" ]] || return 0
  local ssh_host="$T_SSH"
  local privileged="${T_DOCKER:+$T_DOCKER }"

  ssh -o ConnectTimeout=8 "$ssh_host" "timeout -k 5 30 ${privileged}bash '$T_SRC/scripts/reconcile-root-peer-keys.sh' \
    --database '$T_DATA/redman.db' \
    --managed-keys '$T_DATA/ssh-keys/authorized_keys' \
    --rollback-dir '$T_DATA/deploy-rollback'"
}

verify_breakglass_runtime() {
  local ssh_host=$1
  local privileged=$2
  ssh -o ConnectTimeout=8 "$ssh_host" "timeout -k 2 15 ${privileged}bash '$T_SRC/scripts/verify-breakglass-runtime.sh' \
    --manifest '$BREAKGLASS_PLUGIN' \
    --runtime '$BREAKGLASS_TOOL' \
    --runtime '$DEPLOY_GUARD_TOOL'"
}

arm_deployment_guard() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local privileged="${T_DOCKER:+$T_DOCKER }"
  local latched
  local clear_latch=false

  if ! verify_breakglass_runtime "$ssh_host" "$privileged"; then
    echo "Deploy blocked: Container Breakglass runtime is missing or does not match its persistent plugin manifest on $target" >&2
    return 1
  fi

  latched=$(ssh -o ConnectTimeout=8 "$ssh_host" \
    "${privileged}$BREAKGLASS_TOOL status $CONTAINER 2>/dev/null | sed -n 's/^latched=//p'" 2>/dev/null) || true
  if [[ "$latched" == "yes" ]]; then
    if ! $CLEAR_BREAKGLASS_LATCH; then
      echo "Deploy blocked: $CONTAINER is breakglass-latched on $target; use --clear-breakglass-latch explicitly." >&2
      return 1
    fi
    clear_latch=true
  fi

  ssh -o ConnectTimeout=8 "$ssh_host" \
    "${privileged}$DEPLOY_GUARD_TOOL arm $CONTAINER $DEPLOY_GUARD_SECONDS"
  if $clear_latch; then
    ssh -o ConnectTimeout=8 "$ssh_host" "${privileged}$BREAKGLASS_TOOL clear-latch $CONTAINER"
  fi
}

stop_guarded_deployment() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local privileged="${T_DOCKER:+$T_DOCKER }"

  ssh -o ConnectTimeout=8 "$ssh_host" \
    "${privileged}$BREAKGLASS_TOOL kill $CONTAINER; \
     ${privileged}$DEPLOY_GUARD_TOOL disarm $CONTAINER" >/dev/null 2>&1 || true
}

observe_deployment() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local docker_prefix="$T_DOCKER"
  local unraid_canary=""
  local elapsed=0
  local stable=0
  # Adaptive early-exit: promote once we have observed a minimum floor AND seen
  # enough consecutive clean samples, so a healthy deploy clears in ~20-25s
  # instead of always burning the full window. Any single failed sample aborts,
  # so failure detection is unchanged — only the happy path gets shorter.
  local min_seconds=20
  local stable_samples=3
  if (( min_seconds > OBSERVATION_SECONDS )); then min_seconds=$OBSERVATION_SECONDS; fi

  if [[ "$T_SETUP_SCRIPT" == "setup-unraid-backup-user.sh" ]]; then
    unraid_canary="curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:80 >/dev/null;"
  fi

  echo -e "🔭 ${CYAN}Host observation (early-exit after ≥${min_seconds}s + ${stable_samples} stable samples, cap ${OBSERVATION_SECONDS}s)...${NC}"
  while (( elapsed < OBSERVATION_SECONDS )); do
    if ! ssh -o ConnectTimeout=5 -o ConnectionAttempts=1 -o ServerAliveInterval=3 -o ServerAliveCountMax=2 "$ssh_host" "set -e; \
      timeout -k 1 5 curl -fsS --connect-timeout 2 --max-time 3 http://$T_WEB_BIND:$T_PORT/api/health >/dev/null; \
      $unraid_canary \
      available_kb=\$(awk '/MemAvailable:/ {print \$2}' /proc/meminfo); \
      [[ \"\$available_kb\" =~ ^[0-9]+$ && \"\$available_kb\" -ge $MIN_AVAILABLE_MEMORY_KB ]]; \
      [[ \"\$(timeout -k 1 5 ${docker_prefix} docker inspect -f '{{.State.Running}}' $CONTAINER)\" == true ]]; \
      [[ \"\$(timeout -k 1 5 ${docker_prefix} docker inspect -f '{{.State.OOMKilled}}' $CONTAINER)\" == false ]]" >/dev/null 2>&1; then
      echo -e "${RED}Host or application canary failed during observation.${NC}"
      return 1
    fi
    stable=$((stable + 1))
    if (( elapsed >= min_seconds && stable >= stable_samples )); then
      echo -e "${GREEN}Stable (${stable} clean samples over ${elapsed}s) — promoting early.${NC}"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 0
}

preflight_target_resources() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local docker_prefix="$T_DOCKER"
  local unraid_checks=""

  if [[ "$T_SETUP_SCRIPT" == "setup-unraid-backup-user.sh" ]]; then
    unraid_checks="mountpoint -q /mnt/user; pgrep -f '^/usr/libexec/unraid/shfs ' >/dev/null;"
  fi

  echo -e "🩺 ${CYAN}Checking target resources...${NC}"
  ssh -o ConnectTimeout=8 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 "$ssh_host" "set -e; \
    $unraid_checks \
    available_kb=\$(awk '/MemAvailable:/ {print \$2}' /proc/meminfo); \
    [[ \"\$available_kb\" =~ ^[0-9]+$ && \"\$available_kb\" -ge $MIN_AVAILABLE_MEMORY_KB ]]; \
    d_state=\$(ps -eo state= | awk '\$1 ~ /^D/ {count++} END {print count+0}'); \
    [[ \"\$d_state\" -eq 0 ]]; \
    docker_free_kb=\$(df -Pk /var/lib/docker | awk 'NR==2 {print \$4}'); \
    [[ \"\$docker_free_kb\" =~ ^[0-9]+$ && \"\$docker_free_kb\" -ge $MIN_DOCKER_FREE_KB ]]; \
    timeout -k 2 10 ${docker_prefix} docker info >/dev/null"
}

# ── Check-only mode ──
if $CHECK_ONLY; then
  echo -e "${BOLD}Checking activity on ${#DEPLOY_TARGETS[@]} target(s)${NC}"
  echo ""
  all_clear=true
  for target in "${DEPLOY_TARGETS[@]}"; do
    echo -e "${BOLD}── ${target} ──${NC}"
    if ! check_activity "$target"; then
      all_clear=false
    fi
    echo ""
  done
  if $all_clear; then
    echo -e "${GREEN}${BOLD}✅ All targets clear — safe to deploy${NC}"
  else
    echo -e "${RED}${BOLD}⚠️  Some targets have active jobs — use --force to stop them${NC}"
  fi
  exit 0
fi

# ── Deploy function ──
deploy_target() {
  local target=$1
  target_config "$target"
  local ssh_host="$T_SSH"
  local src_dir="$T_SRC"
  local data_dir="$T_DATA"
  local port="$T_PORT"
  local web_bind="$T_WEB_BIND"
  local peer_api_port="$T_PEER_API_PORT"
  local peer_bind="$T_PEER_BIND"
  local docker_prefix="$T_DOCKER"
  local extra_vols="$T_EXTRA_VOLS"
  local backup_root_args="$T_BACKUP_ROOT_ARGS"
  local setup_script="$T_SETUP_SCRIPT"
  local storage_roots="$T_STORAGE_ROOTS"
  local media_root="$T_MEDIA_ROOT"
  local share_config_dir="$T_SHARE_CONFIG_DIR"
  local timezone="$T_TZ"
  local docker_monitoring="$T_DOCKER_MONITORING"
  local docker_cmd="${docker_prefix:+$docker_prefix }docker"
  local runtime_resource_args=""
  local runtime_restart_policy="unless-stopped"
  local existing_container=false

  read_existing_env() {
    local key=$1
    ssh -o ConnectTimeout=5 "$ssh_host" "$docker_cmd inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $CONTAINER 2>/dev/null | sed -n 's/^${key}=//p' | head -n 1" 2>/dev/null || true
  }

  read_existing_resource_args() {
    local names state memory memory_swap nano_cpus pids cpuset cpu_shares restart_name restart_max cpu_limit
    names=$(ssh -o ConnectTimeout=5 "$ssh_host" "timeout -k 1 5 $docker_cmd container ls -a --format '{{.Names}}'" 2>/dev/null) || return 1
    if ! grep -Fxq "$CONTAINER" <<< "$names"; then
      existing_container=false
      return 0
    fi
    existing_container=true
    state=$(ssh -o ConnectTimeout=5 "$ssh_host" "timeout -k 1 5 $docker_cmd inspect --format '{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.CpusetCpus}}|{{.HostConfig.CpuShares}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.RestartPolicy.MaximumRetryCount}}' $CONTAINER" 2>/dev/null) || return 1
    IFS='|' read -r memory memory_swap nano_cpus pids cpuset cpu_shares restart_name restart_max <<< "$state"
    [[ "$memory" =~ ^[0-9]{1,18}$ && "$memory_swap" =~ ^(-1|[0-9]{1,18})$ && "$nano_cpus" =~ ^[0-9]{1,18}$ ]] || return 1
    [[ "$pids" =~ ^(<nil>|<no value>|-1|[0-9]{1,9})$ && "$cpu_shares" =~ ^[0-9]{1,7}$ ]] || return 1
    [[ "$restart_name" =~ ^(no|always|unless-stopped|on-failure)$ && "$restart_max" =~ ^[0-9]{1,9}$ ]] || return 1
    [[ -z "$cpuset" || "$cpuset" =~ ^[0-9,-]+$ ]] || return 1
    (( memory > 0 )) && runtime_resource_args+=" --memory $memory"
    (( memory_swap != 0 )) && runtime_resource_args+=" --memory-swap $memory_swap"
    if (( nano_cpus > 0 )); then
      cpu_limit=$(awk -v value="$nano_cpus" 'BEGIN { printf "%.9g", value / 1000000000 }')
      runtime_resource_args+=" --cpus $cpu_limit"
    fi
    [[ "$pids" != "<nil>" && "$pids" != "<no value>" ]] && (( pids > 0 )) && runtime_resource_args+=" --pids-limit $pids"
    [[ -n "$cpuset" ]] && runtime_resource_args+=" --cpuset-cpus $cpuset"
    (( cpu_shares > 0 && cpu_shares != 1024 )) && runtime_resource_args+=" --cpu-shares $cpu_shares"
    # A promoted, production RedMan container is never legitimately left with
    # --restart no — that value only exists transiently on a restart-disabled
    # canary during the health/observation window. If we see it here, the
    # "existing" container is almost certainly an abandoned canary from a
    # prior deploy attempt that failed before promotion (e.g. this same host
    # after an earlier interrupted run) — preserving it would silently leave
    # the newly-deployed container without auto-restart. Fall back to the
    # sane default instead of blindly copying it forward.
    if [[ "$restart_name" == "no" ]]; then
      echo -e "${YELLOW}  Existing container has --restart no (looks like an abandoned canary from an interrupted deploy) — using unless-stopped instead of preserving it.${NC}" >&2
    else
      runtime_restart_policy="$restart_name"
      if [[ "$restart_name" == "on-failure" ]] && (( restart_max > 0 )); then
        runtime_restart_policy+="${runtime_restart_policy:+:}$restart_max"
      fi
    fi
  }

  if ! read_existing_resource_args; then
    echo -e "${RED}Deploy blocked: existing Docker runtime limits could not be read safely.${NC}"
    return 1
  fi

  local auth_mode="${T_AUTH_MODE:-$(read_existing_env AUTH_MODE)}"
  local public_origin="${T_PUBLIC_ORIGIN:-$(read_existing_env REDMAN_PUBLIC_ORIGIN)}"
  local trusted_proxies="${T_TRUSTED_PROXIES:-$(read_existing_env TRUSTED_PROXIES)}"
  local auto_provision_role="$T_AUTO_PROVISION_ROLE"
  local bootstrap_token="$T_BOOTSTRAP_TOKEN"
  local target_upper
  target_upper=$(printf '%s' "$target" | tr '[:lower:]' '[:upper:]')
  local peer_host="${T_PEER_HOST:-$(read_existing_env PEER_HOST)}"

  if [[ ! "$auth_mode" =~ ^(proxy|local)$ ]]; then
    echo -e "${RED}Deploy blocked: set REDMAN_${target_upper}_AUTH_MODE=proxy|local (or deploy once from an existing configured container).${NC}"
    return 1
  fi
  if [[ ! "$public_origin" =~ ^https://[A-Za-z0-9._:-]+$ ]]; then
    echo -e "${RED}Deploy blocked: set REDMAN_${target_upper}_PUBLIC_ORIGIN to the exact HTTPS origin.${NC}"
    return 1
  fi
  if [[ ! "$trusted_proxies" =~ ^[0-9A-Fa-f:.,/]+$ ]] || [[ -z "$trusted_proxies" ]]; then
    echo -e "${RED}Deploy blocked: set REDMAN_${target_upper}_TRUSTED_PROXIES to the exact proxy source IP/CIDR.${NC}"
    return 1
  fi
  if [[ -z "$peer_host" || "$peer_host" == "0.0.0.0" || ! "$peer_host" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo -e "${RED}Deploy blocked: set REDMAN_${target_upper}_PEER_HOST to the numeric private SSH IP reachable by the other RedMan peer.${NC}"
    return 1
  fi
  if [[ -n "$auto_provision_role" && ! "$auto_provision_role" =~ ^(admin|viewer)$ ]]; then
    echo -e "${RED}Deploy blocked: auto-provision role must be admin, viewer, or empty.${NC}"
    return 1
  fi
  if [[ -n "$bootstrap_token" && ( ${#bootstrap_token} -lt 32 || ! "$bootstrap_token" =~ ^[A-Za-z0-9._~-]+$ ) ]]; then
    echo -e "${RED}Deploy blocked: bootstrap token must be at least 32 URL-safe characters.${NC}"
    return 1
  fi

  local auto_provision_env=""
  local bootstrap_env=""
  local docker_host_env=""
  local docker_control_host_env=""
  local proxy_setup=""
  [[ -n "$auto_provision_role" ]] && auto_provision_env="-e PROXY_AUTO_PROVISION_ROLE='$auto_provision_role'"
  [[ -n "$bootstrap_token" ]] && bootstrap_env="-e REDMAN_BOOTSTRAP_TOKEN='$bootstrap_token'"
  if [[ "$docker_monitoring" == "true" ]]; then
    docker_host_env="http://$DOCKER_READ_PROXY_CONTAINER:2375"
    docker_control_host_env="http://$DOCKER_CONTROL_PROXY_CONTAINER:2375"
    proxy_setup="${docker_prefix} docker rm -f $DOCKER_READ_PROXY_CONTAINER $DOCKER_CONTROL_PROXY_CONTAINER 2>/dev/null || true; \
      ${docker_prefix} docker run -d \
        --name $DOCKER_READ_PROXY_CONTAINER \
        --network $DOCKER_NETWORK \
        --network-alias docker-socket-proxy \
        --security-opt no-new-privileges:true \
        --cap-drop ALL \
        --memory 128m \
        --memory-swap 128m \
        --cpus 0.25 \
        --pids-limit 32 \
        -e REDMAN_DOCKER_PROXY_MODE=read \
        -v /var/run/docker.sock:/var/run/docker.sock:ro \
        --restart unless-stopped \
        $DOCKER_PROXY_IMAGE; \
      ${docker_prefix} docker run -d \
        --name $DOCKER_CONTROL_PROXY_CONTAINER \
        --network $DOCKER_NETWORK \
        --network-alias docker-control-proxy \
        --security-opt no-new-privileges:true \
        --cap-drop ALL \
        --memory 128m \
        --memory-swap 128m \
        --cpus 0.25 \
        --pids-limit 32 \
        -e REDMAN_DOCKER_PROXY_MODE=control \
        -v /var/run/docker.sock:/var/run/docker.sock:ro \
        --restart unless-stopped \
        $DOCKER_PROXY_IMAGE;"
  else
    proxy_setup="${docker_prefix} docker rm -f $DOCKER_READ_PROXY_CONTAINER $DOCKER_CONTROL_PROXY_CONTAINER 2>/dev/null || true;"
  fi

  echo -e "\n${BOLD}═══════════════════════════════════════════════${NC}"
  echo -e "${BOLD} Deploying to ${CYAN}${target}${NC} ${BOLD}(${ssh_host})${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════════${NC}\n"

  # Activity check
  if ! $FORCE; then
    if ! check_activity "$target"; then
      echo -e "\n  ${RED}Deploy blocked — active jobs running.${NC}"
      echo -e "  ${YELLOW}Use --force to gracefully stop jobs and deploy anyway.${NC}"
      return 1
    fi
  else
    if ! check_activity "$target"; then
      graceful_stop "$target"
    fi
  fi

  if ! preflight_target_resources "$target"; then
    echo -e "${RED}Deploy blocked: target resource, user-share, Docker-space, or I/O preflight failed.${NC}" >&2
    return 1
  fi

  echo -e "🗂️  ${CYAN}Preparing target directories...${NC}"
  ssh -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 "$ssh_host" "set -e; \
    ${docker_prefix} install -d -m 0755 '$src_dir'; \
    ${docker_prefix} install -d -m 0750 '$data_dir'; \
    ${docker_prefix} chown \$(id -u):\$(id -g) '$src_dir'"

  echo ""
  echo -e "📦 ${CYAN}Syncing files...${NC}"
  rsync -avz --delete --timeout=120 \
    -e "ssh -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2" \
    "${RSYNC_EXCLUDES[@]}" \
    "$SCRIPT_DIR/" "$ssh_host:$src_dir/"

  echo -e "🔐 ${CYAN}Provisioning restricted backup SSH account...${NC}"
  ssh -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 "$ssh_host" \
    "timeout -k 10 $SETUP_TIMEOUT_SECONDS ${docker_prefix} bash $src_dir/scripts/$setup_script --data-dir '$data_dir' $backup_root_args"

  echo -e "🔨 ${CYAN}Building image...${NC}"
  ssh -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 "$ssh_host" "cd $src_dir && \
    timeout -k 30 $BUILD_TIMEOUT_SECONDS ${docker_prefix} docker build --target docker-api-proxy -t $DOCKER_PROXY_IMAGE:latest . && \
    timeout -k 30 $BUILD_TIMEOUT_SECONDS ${docker_prefix} docker build -t $CONTAINER:latest ."

  echo -e "🛟 ${CYAN}Capturing rollback metadata and arming deployment guard...${NC}"
  capture_rollback_metadata "$target"
  arm_deployment_guard "$target"

  echo -e "🔄 ${CYAN}Replacing container...${NC}"
  ssh "$ssh_host" "set -e; ${docker_prefix} docker network inspect $DOCKER_NETWORK >/dev/null 2>&1 || ${docker_prefix} docker network create $DOCKER_NETWORK; \
    $proxy_setup \
    ${docker_prefix} docker rm -f $CONTAINER 2>/dev/null || true; \
    ${docker_prefix} docker run -d \
      --name $CONTAINER \
      --network $DOCKER_NETWORK \
      --label com.centurylinklabs.watchtower.enable=false \
      --security-opt no-new-privileges:true \
      --cap-drop ALL \
      --cap-add DAC_READ_SEARCH \
      $runtime_resource_args \
      -p $web_bind:$port:8090 \
      -p $peer_bind:$peer_api_port:8091 \
      -v $data_dir:/app/backend/data \
      $extra_vols \
      -e NODE_ENV=production \
      -e AUTH_MODE='$auth_mode' \
      -e REDMAN_PUBLIC_ORIGIN='$public_origin' \
      -e TRUSTED_PROXIES='$trusted_proxies' \
      $auto_provision_env \
      $bootstrap_env \
      -e PORT=8090 \
      -e PEER_API_PORT=8091 \
      -e PEER_HOST='$peer_host' \
      -e SSH_USER=redman-backup \
      -e RRSYNC_PATH=/usr/local/bin/rrsync \
      -e REDMAN_STORAGE_ROOTS='$storage_roots' \
      -e REDMAN_MEDIA_ROOT='$media_root' \
      -e REDMAN_SHARE_CONFIG_DIR='$share_config_dir' \
      -e DOCKER_HOST='$docker_host_env' \
      -e DOCKER_CONTROL_HOST='$docker_control_host_env' \
      -e TZ='$timezone' \
      --restart no \
      $CONTAINER:latest"

  # Wait for health check
  echo -e "⏳ ${CYAN}Waiting for health check...${NC}"
  local healthy=false
  for i in $(seq 1 "$HEALTH_TIMEOUT_SECONDS"); do
    if ssh -o ConnectTimeout=3 -o ConnectionAttempts=1 -o ServerAliveInterval=3 -o ServerAliveCountMax=2 \
      "$ssh_host" "timeout -k 1 5 curl -fsS --connect-timeout 2 --max-time 3 http://${web_bind}:${port}/api/health" >/dev/null 2>&1; then
      healthy=true
      break
    fi
    sleep 1
  done

  if $healthy; then
    # Check if migration ran
    local logs
    logs=$(ssh "$ssh_host" "${docker_prefix} docker logs $CONTAINER 2>&1 | grep -E 'migration|Migration' | tail -5" 2>/dev/null) || true
    if [[ -n "$logs" ]]; then
      echo -e "  ${CYAN}Migrations:${NC}"
      echo "$logs" | sed 's/^/    /'
    fi

    if ! observe_deployment "$target"; then
      stop_guarded_deployment "$target"
      return 1
    fi

    if ! remove_reconciled_root_peer_keys "$target"; then
      echo -e "${RED}Restricted SSH reconciliation could not safely remove matching legacy root keys.${NC}"
      stop_guarded_deployment "$target"
      return 1
    fi

    ssh -o ConnectTimeout=8 "$ssh_host" "${docker_prefix} docker update --restart '$runtime_restart_policy' $CONTAINER >/dev/null"
    if ! capture_current_runtime_receipt "$target"; then
      echo -e "${RED}Could not persist promoted container reconstruction metadata.${NC}"
      stop_guarded_deployment "$target"
      return 1
    fi
    ssh -o ConnectTimeout=8 "$ssh_host" "${docker_prefix} $DEPLOY_GUARD_TOOL disarm $CONTAINER"
    echo -e "${GREEN}✅ ${target} live and host-stable at http://${ssh_host}:${port}${NC}"
  else
    echo -e "${RED}❌ ${target} — health check failed after ${HEALTH_TIMEOUT_SECONDS}s${NC}"
    ssh "$ssh_host" "${docker_prefix} docker logs --tail 10 $CONTAINER" 2>/dev/null || true
    stop_guarded_deployment "$target"
    return 1
  fi

  if $DO_SEED; then
    echo -e "🌱 ${CYAN}Seeding database...${NC}"
    ssh "$ssh_host" "${docker_prefix} docker exec $CONTAINER node src/seed.js"
  fi
}

# ── Main ──
echo -e "${BOLD}RedMan deploy → ${DEPLOY_TARGETS[*]}${NC}"

FAILED=()
for target in "${DEPLOY_TARGETS[@]}"; do
  if ! deploy_target "$target"; then
    FAILED+=("$target")
    break
  fi
done

echo ""
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo -e "${RED}${BOLD}⚠️  Failed: ${FAILED[*]}${NC}"
  exit 1
else
  echo -e "${GREEN}${BOLD}✅ All deployments complete${NC}"
fi
