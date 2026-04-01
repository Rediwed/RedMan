#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# setup_local_test.sh — Launch two RedMan instances for Hyper Backup testing
#
# Instance A: ports 8090 (API) / 8091 (peer) / 5175 (UI)
# Instance B: ports 8094 (API) / 8095 (peer) / 5176 (UI — API only, no Vite)
#
# Usage:
#   ./test/setup_local_test.sh           # Start both instances
#   ./test/setup_local_test.sh --stop    # Stop all test instances
#   ./test/setup_local_test.sh --seed    # Seed databases only (no start)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DATA="$SCRIPT_DIR/data"
PID_FILE="$TEST_DATA/.test_pids"

# Instance A — primary
PORT_A=8090
PEER_PORT_A=8091
VITE_PORT_A=5175
DB_A="$TEST_DATA/instance_a/redman.db"

# Instance B — remote peer
PORT_B=8094
PEER_PORT_B=8095
DB_B="$TEST_DATA/instance_b/redman.db"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}ℹ️  $*${NC}"; }
ok()    { echo -e "${GREEN}✅ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }
error() { echo -e "${RED}❌ $*${NC}"; }

# ── Stop all test processes ──────────────────────────────────────────
stop_all() {
    info "Stopping test instances..."

    # Kill known PIDs
    if [[ -f "$PID_FILE" ]]; then
        while read -r pid; do
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null && echo "  Stopped PID $pid"
            fi
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi

    # Kill anything on test ports
    for port in $PORT_A $PEER_PORT_A $VITE_PORT_A $PORT_B $PEER_PORT_B; do
        lsof -ti:"$port" 2>/dev/null | while read -r pid; do
            kill "$pid" 2>/dev/null && echo "  Killed process on port $port (PID $pid)"
        done
    done

    ok "All test instances stopped."
}

# ── Seed databases ──────────────────────────────────────────────────
seed_databases() {
    info "Seeding databases..."

    mkdir -p "$(dirname "$DB_A")" "$(dirname "$DB_B")"

    # Seed Instance A
    cd "$PROJECT_DIR/app"
    DB_PATH="$DB_A" npm run seed --silent 2>&1 | sed 's/^/  [A] /'
    ok "Instance A database seeded: $DB_A"

    # Seed Instance B
    DB_PATH="$DB_B" npm run seed --silent 2>&1 | sed 's/^/  [B] /'
    ok "Instance B database seeded: $DB_B"

    # Seed test configurations
    cd "$PROJECT_DIR"
    info "Seeding test configurations..."
    node test/seed_test_configs.js "$DB_A" "$DB_B" "$TEST_DATA"
    ok "Test configurations seeded."
}

# ── Check prerequisites ─────────────────────────────────────────────
check_prereqs() {
    # Check node_modules (npm workspaces hoists to app/node_modules/)
    if [[ ! -d "$PROJECT_DIR/app/node_modules" ]]; then
        error "Dependencies not installed. Run: cd app && npm install"
        exit 1
    fi

    # Check test data exists
    if [[ ! -d "$TEST_DATA/source" ]]; then
        warn "No test data found at $TEST_DATA/source"
        warn "Generate it first: python test/generate_test_data.py --size small"
    fi

    # Check macOS Remote Login (SSH) for Hyper Backup
    if [[ "$(uname)" == "Darwin" ]]; then
        if ! systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then
            warn "macOS Remote Login (SSH) is not enabled."
            warn "Enable it for Hyper Backup testing:"
            warn "  System Settings → General → Sharing → Remote Login → ON"
        fi
    fi
}

# ── Start instances ──────────────────────────────────────────────────
start_instances() {
    check_prereqs

    # Stop any existing test processes
    stop_all 2>/dev/null || true

    # Seed if databases don't exist
    if [[ ! -f "$DB_A" ]] || [[ ! -f "$DB_B" ]]; then
        seed_databases
    fi

    mkdir -p "$TEST_DATA"
    > "$PID_FILE"

    info "Starting Instance A (primary)..."
    cd "$PROJECT_DIR/app/backend"
    PORT=$PORT_A \
    PEER_API_PORT=$PEER_PORT_A \
    DB_PATH="$DB_A" \
    AUTH_DISABLED=true \
    node --watch src/index.js > "$TEST_DATA/instance_a.log" 2>&1 &
    echo $! >> "$PID_FILE"
    ok "Instance A backend: http://localhost:$PORT_A (PID $!)"

    info "Starting Instance B (remote peer)..."
    PORT=$PORT_B \
    PEER_API_PORT=$PEER_PORT_B \
    DB_PATH="$DB_B" \
    AUTH_DISABLED=true \
    node --watch src/index.js > "$TEST_DATA/instance_b.log" 2>&1 &
    echo $! >> "$PID_FILE"
    ok "Instance B backend: http://localhost:$PORT_B (PID $!)"

    info "Starting Vite dev server for Instance A..."
    cd "$PROJECT_DIR/app/frontend"
    npx vite --port $VITE_PORT_A > "$TEST_DATA/vite_a.log" 2>&1 &
    echo $! >> "$PID_FILE"
    ok "Instance A UI: http://localhost:$VITE_PORT_A (PID $!)"

    # Wait for backends to start
    sleep 2

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    ok "Test environment ready!"
    echo ""
    echo "  Instance A (primary):"
    echo "    UI:   http://localhost:$VITE_PORT_A"
    echo "    API:  http://localhost:$PORT_A/api/health"
    echo "    Peer: http://localhost:$PEER_PORT_A"
    echo "    DB:   $DB_A"
    echo "    Log:  $TEST_DATA/instance_a.log"
    echo ""
    echo "  Instance B (remote peer):"
    echo "    API:  http://localhost:$PORT_B/api/health"
    echo "    Peer: http://localhost:$PEER_PORT_B"
    echo "    DB:   $DB_B"
    echo "    Log:  $TEST_DATA/instance_b.log"
    echo ""
    echo "  Test data: $TEST_DATA/source/"
    echo ""
    echo "  To stop:  ./test/setup_local_test.sh --stop"
    echo "  Logs:     tail -f $TEST_DATA/instance_a.log"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Wait for any child to exit
    wait
}

# ── Entry point ──────────────────────────────────────────────────────
case "${1:-start}" in
    --stop|stop)
        stop_all
        ;;
    --seed|seed)
        seed_databases
        ;;
    --start|start|"")
        start_instances
        ;;
    *)
        echo "Usage: $0 [--start|--stop|--seed]"
        exit 1
        ;;
esac
