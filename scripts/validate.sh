#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Validation owns its fixtures. Never let a currently sourced production .env
# redirect databases, ports, authentication, storage roots, or Docker clients.
unset DB_PATH PORT PEER_API_PORT PEER_HOST SSH_USER SSH_PORT
unset AUTH_MODE AUTH_DISABLED REDMAN_LOCAL_DEV REDMAN_PUBLIC_ORIGIN TRUSTED_PROXIES
unset PROXY_AUTO_PROVISION_ROLE REDMAN_BOOTSTRAP_TOKEN SESSION_COOKIE_SECURE
unset DOCKER_HOST REDMAN_STORAGE_ROOTS REDMAN_MEDIA_ROOT REDMAN_SHARE_CONFIG_DIR
unset VITE_PORT VITE_HOST VITE_API_URL
export TZ=UTC

echo '[1/8] Lint'
npm --prefix app run lint

echo '[2/8] Focused and integration regressions'
npm --prefix app run test:mitigations

echo '[3/8] Clean-volume startup'
node test/test_fresh_start.mjs

echo '[4/8] Backward compatibility contract'
node test/test_backward_compat.mjs --skip-live

echo '[5/8] Frontend production build'
npm --prefix app run build

echo '[6/8] Dependency audit'
npm --prefix app audit --audit-level=high

echo '[7/8] Desktop/mobile browser and accessibility smoke'
npm --prefix app run test:browser

echo '[8/8] Greenfield Linux/OpenSSH, Compose, and Docker proxy ACLs'
npm --prefix app run test:greenfield

echo 'RedMan validation passed.'