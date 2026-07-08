#!/bin/bash
# Deploy RedMan to Unraid instances
#
# Usage:
#   ./deploy.sh                     # Deploy to citadelle (default)
#   ./deploy.sh --kasbah            # Deploy to kasbah only
#   ./deploy.sh --both              # Deploy to both
#   ./deploy.sh --seed              # Reseed database after deploy
#   ./deploy.sh --test              # Include test/ directory
#   ./deploy.sh --force             # Skip activity check, stop active jobs gracefully
#   ./deploy.sh --check             # Only check for active jobs, don't deploy
#
# The script refuses to deploy if there are active backup/import jobs running,
# unless --force is used (which gracefully stops them first).

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
# Returns target config by name. Usage: eval "$(target_config citadelle)"
target_config() {
  case "$1" in
    citadelle)
      T_SSH="unraid"
      T_SRC="/mnt/user/appdata/redman-src"
      T_DATA="/mnt/user/appdata/redman"
      T_PORT="8090"
      T_PEER_PORT="8091"
      T_DOCKER=""
      T_EXTRA_VOLS="-v /boot/config/shares:/boot/config/shares:ro -v /mnt/user:/mnt/user -v /mnt/cache:/mnt/cache:ro --mount type=bind,source=/mnt/disks,target=/mnt/disks,bind-propagation=rslave -v /root/.ssh/authorized_keys:/host-ssh/authorized_keys"
      ;;
    kasbah)
      T_SSH="kasbah"
      T_SRC="/mnt/fast/appdata/redman-src"
      T_DATA="/mnt/fast/appdata/redman"
      T_PORT="8090"
      T_PEER_PORT="8091"
      T_DOCKER="sudo"
      T_EXTRA_VOLS="-v /boot/config/shares:/boot/config/shares:ro -v /mnt/user:/mnt/user --mount type=bind,source=/mnt/disks,target=/mnt/disks,bind-propagation=rslave -v /mnt/fast/appdata/ssh-keys/authorized_keys:/host-ssh/authorized_keys"
      ;;
    *)
      echo -e "${RED}Unknown target: $1${NC}"
      return 1
      ;;
  esac
}

CONTAINER="redman"

# ── Parse args ──
DEPLOY_TARGETS=()
DO_SEED=false
INCLUDE_TEST=false
FORCE=false
CHECK_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --citadelle)  DEPLOY_TARGETS+=(citadelle) ;;
    --kasbah)     DEPLOY_TARGETS+=(kasbah) ;;
    --both)       DEPLOY_TARGETS+=(citadelle kasbah) ;;
    --seed)       DO_SEED=true ;;
    --test)       INCLUDE_TEST=true ;;
    --force)      FORCE=true ;;
    --check)      CHECK_ONLY=true ;;
    --help|-h)
      echo "Usage: ./deploy.sh [--citadelle|--kasbah|--both] [--seed] [--test] [--force] [--check]"
      echo ""
      echo "  --citadelle   Deploy to citadelle only (default if no target specified)"
      echo "  --kasbah      Deploy to kasbah only"
      echo "  --both        Deploy to both citadelle and kasbah"
      echo "  --seed        Reseed database after deploy (destructive!)"
      echo "  --test        Include test/ directory in sync"
      echo "  --force       Skip activity check and gracefully stop active jobs"
      echo "  --check       Only check for active jobs, don't deploy"
      echo ""
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $arg${NC} (use --help)"
      exit 1
      ;;
  esac
done

# Default to citadelle if no target specified
if [[ ${#DEPLOY_TARGETS[@]} -eq 0 ]]; then
  DEPLOY_TARGETS=(citadelle kasbah)
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
  local port="$T_PORT"
  local docker_prefix="$T_DOCKER"

  echo -e "  ${CYAN}Checking for active jobs on ${target}...${NC}"

  # Check if container is running
  local running
  running=$(ssh -o ConnectTimeout=5 "$ssh_host" "${docker_prefix} docker ps -q -f name=$CONTAINER" 2>/dev/null)
  if [[ -z "$running" ]]; then
    echo -e "  ${YELLOW}Container not running — safe to deploy${NC}"
    return 0
  fi

  # Query the health endpoint for active job count
  local health
  health=$(ssh -o ConnectTimeout=5 "$ssh_host" "curl -sf http://localhost:${port}/api/health" 2>/dev/null) || true

  if [[ -z "$health" ]]; then
    echo -e "  ${YELLOW}API not reachable — container may be unhealthy${NC}"
    return 0
  fi

  local active_jobs
  active_jobs=$(echo "$health" | grep -o '"runningJobs":[0-9]*' | cut -d: -f2)

  if [[ -z "$active_jobs" || "$active_jobs" == "0" ]]; then
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
  local peer_port="$T_PEER_PORT"
  local docker_prefix="$T_DOCKER"
  local extra_vols="$T_EXTRA_VOLS"

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

  echo ""
  echo -e "📦 ${CYAN}Syncing files...${NC}"
  rsync -avz --delete \
    "${RSYNC_EXCLUDES[@]}" \
    "$SCRIPT_DIR/" "$ssh_host:$src_dir/"

  echo -e "🔨 ${CYAN}Building image...${NC}"
  ssh "$ssh_host" "cd $src_dir && ${docker_prefix} docker build -t $CONTAINER:latest ."

  echo -e "🔄 ${CYAN}Replacing container...${NC}"
  ssh "$ssh_host" "${docker_prefix} docker rm -f $CONTAINER 2>/dev/null; \
    ${docker_prefix} docker run -d \
      --name $CONTAINER \
      --label com.centurylinklabs.watchtower.enable=false \
      --security-opt no-new-privileges:true \
      --cap-drop ALL \
      --cap-add DAC_READ_SEARCH \
      -p $port:8090 \
      -p $peer_port:8091 \
      -v $data_dir:/app/backend/data \
      -v /var/run/docker.sock:/var/run/docker.sock:ro \
      $extra_vols \
      -e NODE_ENV=production \
      -e PORT=8090 \
      -e PEER_PORT=8091 \
      -e TZ=Europe/Amsterdam \
      --restart unless-stopped \
      $CONTAINER:latest"

  # Wait for health check
  echo -e "⏳ ${CYAN}Waiting for health check...${NC}"
  local healthy=false
  for i in $(seq 1 20); do
    if ssh -o ConnectTimeout=3 "$ssh_host" "curl -sf http://localhost:${port}/api/health" >/dev/null 2>&1; then
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

    echo -e "${GREEN}✅ ${target} live at http://${ssh_host}:${port}${NC}"
  else
    echo -e "${RED}❌ ${target} — health check failed after 20s${NC}"
    ssh "$ssh_host" "${docker_prefix} docker logs --tail 10 $CONTAINER" 2>/dev/null || true
    return 1
  fi

  if $DO_SEED; then
    echo -e "🌱 ${CYAN}Seeding database...${NC}"
    ssh "$ssh_host" "${docker_prefix} docker exec $CONTAINER node src/seed.js"
  fi
}

# ── Main ──
echo -e "${BOLD}RedMan deploy → ${DEPLOY_TARGETS[*]}${NC}"

if [[ ${#DEPLOY_TARGETS[@]} -gt 1 ]]; then
  # Parallel deploy
  PIDS=()
  LOGS=()
  for target in "${DEPLOY_TARGETS[@]}"; do
    LOG=$(mktemp)
    LOGS+=("$LOG")
    deploy_target "$target" > "$LOG" 2>&1 &
    PIDS+=($!)
  done

  FAILED=()
  for i in "${!DEPLOY_TARGETS[@]}"; do
    if wait "${PIDS[$i]}"; then
      echo -e "${GREEN}✅ ${DEPLOY_TARGETS[$i]} deployed${NC}"
    else
      echo -e "${RED}❌ ${DEPLOY_TARGETS[$i]} failed${NC}"
      FAILED+=("${DEPLOY_TARGETS[$i]}")
    fi
    # Show key lines from log
    grep -E '✅|❌|migration|Migration|error|Error' "${LOGS[$i]}" 2>/dev/null | sed "s/^/  [${DEPLOY_TARGETS[$i]}] /"
    rm -f "${LOGS[$i]}"
  done
else
  # Single target
  FAILED=()
  for target in "${DEPLOY_TARGETS[@]}"; do
    if ! deploy_target "$target"; then
      FAILED+=("$target")
    fi
  done
fi

echo ""
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo -e "${RED}${BOLD}⚠️  Failed: ${FAILED[*]}${NC}"
  exit 1
else
  echo -e "${GREEN}${BOLD}✅ All deployments complete${NC}"
fi
