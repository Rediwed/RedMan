#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# pre-push.sh — Full validation gate before deploying RedMan
#
# Runs the complete test suite + backward compatibility checks.
# Must pass before building or pushing any changes.
#
# Usage:
#   ./pre-push.sh                 # Full suite (compat + medium integration)
#   ./pre-push.sh --quick         # Compat only + small integration test
#   ./pre-push.sh --compat-only   # Backward compatibility checks only (no integration)
#   ./pre-push.sh --skip-build    # Skip Docker build verification
#   ./pre-push.sh --deploy        # Run tests, build, and deploy to Unraid
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Defaults ──
SCALE="medium"
RUN_INTEGRATION=true
RUN_BUILD=true
RUN_DEPLOY=false
KEEP_DATA=false

# ── Parse args ──
for arg in "$@"; do
  case "$arg" in
    --quick)        SCALE="small" ;;
    --compat-only)  RUN_INTEGRATION=false ;;
    --skip-build)   RUN_BUILD=false ;;
    --deploy)       RUN_DEPLOY=true ;;
    --keep-data)    KEEP_DATA=true ;;
    --help|-h)
      echo "Usage: ./pre-push.sh [--quick|--compat-only|--skip-build|--deploy|--keep-data]"
      echo ""
      echo "  --quick         Use small scale instead of medium for faster runs"
      echo "  --compat-only   Only run backward compatibility checks (no integration)"
      echo "  --skip-build    Skip frontend build verification"
      echo "  --deploy        After all tests pass, deploy to Unraid via deploy.sh"
      echo "  --keep-data     Don't clean up test data after integration tests"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --help for usage)"
      exit 1
      ;;
  esac
done

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
STEPS=()

step_pass() {
  PASS=$((PASS + 1))
  STEPS+=("${GREEN}✅ $1${NC}")
  echo -e "${GREEN}✅ $1${NC}"
}

step_fail() {
  FAIL=$((FAIL + 1))
  STEPS+=("${RED}❌ $1${NC}")
  echo -e "${RED}❌ $1${NC}"
}

# ── Header ──
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo -e "${BOLD} RedMan Pre-Push Validation${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo -e " Scale: ${CYAN}$SCALE${NC}  Integration: ${CYAN}$RUN_INTEGRATION${NC}  Build: ${CYAN}$RUN_BUILD${NC}"
echo ""

# ──────────────────────────────────────────────────
# Step 1: Syntax check all backend files
# ──────────────────────────────────────────────────
echo -e "${YELLOW}▶ Step 1: Backend syntax check${NC}"
SYNTAX_OK=true
for f in app/backend/src/index.js app/backend/src/peerApi.js app/backend/src/db.js app/backend/src/migrations.js app/backend/src/seed.js; do
  if ! node --check "$f" 2>/dev/null; then
    echo "  Syntax error in $f"
    SYNTAX_OK=false
  fi
done

for f in app/backend/src/routes/*.js app/backend/src/services/*.js; do
  if ! node --check "$f" 2>/dev/null; then
    echo "  Syntax error in $f"
    SYNTAX_OK=false
  fi
done

if $SYNTAX_OK; then
  step_pass "Backend syntax check"
else
  step_fail "Backend syntax check"
fi

# ──────────────────────────────────────────────────
# Step 2: Backward compatibility — static checks
# ──────────────────────────────────────────────────
echo -e "\n${YELLOW}▶ Step 2: Backward compatibility (static)${NC}"
if node test/test_backward_compat.mjs --skip-live 2>&1 | tee /tmp/redman_compat.log | tail -5; then
  if grep -q "0 failed" /tmp/redman_compat.log; then
    step_pass "Backward compatibility (static)"
  else
    step_fail "Backward compatibility (static) — see output above"
  fi
else
  step_fail "Backward compatibility (static) — script crashed"
fi

# ──────────────────────────────────────────────────
# Step 3: Frontend build
# ──────────────────────────────────────────────────
if $RUN_BUILD; then
  echo -e "\n${YELLOW}▶ Step 3: Frontend build${NC}"
  if (cd app && npm run build) 2>&1 | tail -5; then
    step_pass "Frontend build"
  else
    step_fail "Frontend build"
  fi
else
  echo -e "\n${YELLOW}▶ Step 3: Frontend build (skipped)${NC}"
fi

# ──────────────────────────────────────────────────
# Step 4: Start test instances
# ──────────────────────────────────────────────────
if $RUN_INTEGRATION; then
  echo -e "\n${YELLOW}▶ Step 4: Starting test instances${NC}"

  # Stop any existing instances first
  ./test/setup_local_test.sh --stop 2>/dev/null || true
  sleep 1

  if ./test/setup_local_test.sh 2>&1 | tail -3; then
    # Wait for API to be ready
    echo "  Waiting for API..."
    READY=false
    for i in $(seq 1 30); do
      if curl -sf http://localhost:8090/api/health >/dev/null 2>&1; then
        READY=true
        break
      fi
      sleep 1
    done

    if $READY; then
      step_pass "Test instances started"
    else
      step_fail "Test instances — API not reachable after 30s"
      RUN_INTEGRATION=false
    fi
  else
    step_fail "Test instances failed to start"
    RUN_INTEGRATION=false
  fi
fi

# ──────────────────────────────────────────────────
# Step 5: Backward compatibility — live API checks
# ──────────────────────────────────────────────────
if $RUN_INTEGRATION; then
  echo -e "\n${YELLOW}▶ Step 5: Backward compatibility (live API)${NC}"
  if node test/test_backward_compat.mjs 2>&1 | tee /tmp/redman_compat_live.log | tail -5; then
    if grep -q "0 failed" /tmp/redman_compat_live.log; then
      step_pass "Backward compatibility (live API)"
    else
      step_fail "Backward compatibility (live API) — see output above"
    fi
  else
    step_fail "Backward compatibility (live API) — script crashed"
  fi
fi

# ──────────────────────────────────────────────────
# Step 6: Comprehensive integration test
# ──────────────────────────────────────────────────
if $RUN_INTEGRATION; then
  INTEG_ARGS="--scale $SCALE"
  if $KEEP_DATA; then
    INTEG_ARGS="$INTEG_ARGS --keep-data"
  fi

  echo -e "\n${YELLOW}▶ Step 6: Integration test (scale=$SCALE)${NC}"
  if node test/test_comprehensive.mjs $INTEG_ARGS 2>&1 | tee /tmp/redman_integration.log | tail -20; then
    # Check for test pass in output
    if grep -qE "(All .* passed|PASSED|0 failed)" /tmp/redman_integration.log; then
      step_pass "Integration test ($SCALE)"
    elif [ ${PIPESTATUS[0]} -eq 0 ]; then
      step_pass "Integration test ($SCALE)"
    else
      step_fail "Integration test ($SCALE)"
    fi
  else
    step_fail "Integration test ($SCALE)"
  fi
fi

# ──────────────────────────────────────────────────
# Step 7: Stop test instances
# ──────────────────────────────────────────────────
if $RUN_INTEGRATION; then
  echo -e "\n${YELLOW}▶ Stopping test instances${NC}"
  ./test/setup_local_test.sh --stop 2>/dev/null || true
fi

# ──────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo -e "${BOLD} Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo ""
for s in "${STEPS[@]}"; do
  echo -e "  $s"
done
echo ""

if [ $FAIL -gt 0 ]; then
  echo -e "${RED}${BOLD}🚫 PUSH BLOCKED — fix failures above before deploying${NC}"
  echo ""
  exit 1
fi

echo -e "${GREEN}${BOLD}✅ All checks passed${NC}"

# ──────────────────────────────────────────────────
# Step 8: Deploy (if requested)
# ──────────────────────────────────────────────────
if $RUN_DEPLOY; then
  echo ""
  echo -e "${YELLOW}▶ Deploying to Unraid...${NC}"
  ./deploy.sh
fi

echo ""
