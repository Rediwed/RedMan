#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
CHECK_ONLY=false
if [[ "$MODE" == "check" ]]; then
  CHECK_ONLY=true
elif [[ "$MODE" != "patch" && "$MODE" != "minor" && "$MODE" != "major" ]]; then
  echo "Usage: ./scripts/release.sh check|patch|minor|major" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

RELEASE_ENV_FILE="${REDMAN_RELEASE_ENV_FILE:-$ROOT/.redman-release.env}"
if [[ -f "$RELEASE_ENV_FILE" ]]; then
  # Local maintainer configuration; this file is intentionally gitignored.
  # shellcheck source=/dev/null
  source "$RELEASE_ENV_FILE"
fi

version_consistency() {
  node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const expected = readJson('package.json').version;
const versions = new Map([
  ['package.json', expected],
  ['app/package.json', readJson('app/package.json').version],
  ['app/backend/package.json', readJson('app/backend/package.json').version],
  ['app/frontend/package.json', readJson('app/frontend/package.json').version],
]);
const extract = (path, expression) => readFileSync(path, 'utf8').match(expression)?.[1];
versions.set('app/backend/src/index.js', extract('app/backend/src/index.js', /version:\s*['"]([^'"]+)['"]/));
versions.set('app/backend/src/peerApi.js', extract('app/backend/src/peerApi.js', /version:\s*['"]([^'"]+)['"]/));
versions.set('app/backend/src/contracts/v1.json', readJson('app/backend/src/contracts/v1.json').version);
versions.set('app/frontend/src/version.js', extract('app/frontend/src/version.js', /APP_VERSION\s*=\s*['"]([^'"]+)['"]/));
const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  for (const [path, version] of mismatches) console.error(`${path}: ${version || 'missing'} (expected ${expected})`);
  process.exit(1);
}
console.log(`Version consistency: ${expected} across ${versions.size} sources`);
NODE
}

helper_consistency() {
  node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const source = readFileSync('app/backend/src/services/upgradeReadiness.js', 'utf8');
const files = ['prepare-upgrade-host.sh', 'setup-backup-user.sh', 'setup-unraid-backup-user.sh'];
for (const file of files) {
  const actual = createHash('sha256').update(readFileSync(`scripts/${file}`)).digest('hex');
  const expression = new RegExp(`['"]${file.replaceAll('.', '\\.') }['"]:\\s*['"]([a-f0-9]{64})['"]`);
  const expected = source.match(expression)?.[1];
  if (!expected || expected !== actual) {
    console.error(`${file}: embedded checksum ${expected || 'missing'} does not match ${actual}`);
    process.exit(1);
  }
}
if (!source.includes("const HELPER_RELEASE = 'v1.1.7'")) {
  console.error('Upgrade helper release must be pinned to v1.1.7 for FAT-safe Unraid boot replay');
  process.exit(1);
}
console.log('Host helper integrity: 3 embedded checksums match v1.1.7 sources');
NODE
}

run_checks() {
  echo "Running bridge tests..."
  npm --prefix app test
  echo "Running production build..."
  npm --prefix app run build
  echo "Running dependency audit..."
  npm --prefix app audit --audit-level=low
  echo "Checking version consistency..."
  version_consistency
  echo "Checking host helper integrity..."
  helper_consistency
  echo "Checking release notes..."
  grep -q '^## \[Unreleased\]' CHANGELOG.md || { echo "CHANGELOG.md has no [Unreleased] block" >&2; exit 1; }
  awk '
    /^## \[Unreleased\]/ { inside=1; next }
    inside && /^## \[/ { exit }
    inside && /^[[:space:]]*-[[:space:]]+\[[xX]\]/ { found=1 }
    END { exit found ? 0 : 1 }
  ' CHANGELOG.md || { echo "CHANGELOG.md has no public [Unreleased] bullets" >&2; exit 1; }
}

if $CHECK_ONLY; then
  run_checks
  echo "RedMan release check passed. No files were changed."
  exit 0
fi

[[ "$(git branch --show-current)" == "main" ]] || { echo "Releases must run from main" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "Working tree must be clean" >&2; git status --short; exit 1; }
git pull --ff-only
run_checks

CURRENT_VERSION="$(node -p "require('./package.json').version")"
case "$CURRENT_VERSION:$MODE" in
  1.0.0:minor|1.1.0:patch|1.1.1:patch|1.1.2:patch|1.1.3:patch|1.1.4:patch|1.1.5:patch|1.1.6:patch|1.1.7:patch) ;;
  *)
    echo "Bridge releases are limited to v1.1.0 through v1.1.8; v1.1.8 adds editable IANA timezone configuration." >&2
    exit 1
    ;;
esac
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
[[ "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid semantic version: $CURRENT_VERSION" >&2; exit 1; }
MAJOR=$((10#$MAJOR))
MINOR=$((10#$MINOR))
PATCH=$((10#$PATCH))
case "$MODE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
TODAY="$(date +%Y-%m-%d)"
echo "Releasing $CURRENT_VERSION -> $NEW_VERSION"

node --input-type=module - "$NEW_VERSION" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const version = process.argv[2];
const jsonFiles = ['package.json', 'app/package.json', 'app/backend/package.json', 'app/frontend/package.json'];
for (const path of jsonFiles) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  value.version = version;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
const lockPath = 'app/package-lock.json';
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = version;
for (const key of ['', 'backend', 'frontend']) {
  if (lock.packages?.[key]) lock.packages[key].version = version;
}
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

const replace = (path, expression, replacement) => {
  const source = readFileSync(path, 'utf8');
  const next = source.replace(expression, replacement);
  if (next === source) throw new Error(`Version marker not found in ${path}`);
  writeFileSync(path, next);
};
replace('app/backend/src/index.js', /(version:\s*['"])[^'"]+(['"])/, `$1${version}$2`);
replace('app/backend/src/peerApi.js', /(version:\s*['"])[^'"]+(['"])/, `$1${version}$2`);
replace('app/backend/src/contracts/v1.json', /("version"\s*:\s*")[^"]+(\")/, `$1${version}$2`);
replace('app/frontend/src/version.js', /(APP_VERSION\s*=\s*['"])[^'"]+(['"])/, `$1${version}$2`);
NODE

awk -v version="$NEW_VERSION" -v today="$TODAY" '
  BEGIN { state="before" }
  state == "before" && /^## \[Unreleased\]/ {
    print "## [Unreleased]"
    print ""
    print "## [" version "] - " today
    state="unreleased"
    next
  }
  state == "unreleased" && /^## \[/ { state="after"; print; next }
  state == "unreleased" {
    if ($0 ~ /^[[:space:]]*-[[:space:]]+\[[[:space:]]\]/) next
    sub(/-[[:space:]]+\[[xX]\][[:space:]]+/, "- ")
    print
    next
  }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp
mv CHANGELOG.md.tmp CHANGELOG.md

version_consistency
git add -A
git commit -m "release: v$NEW_VERSION"
TAG_BODY="$(awk -v version="$NEW_VERSION" '$0 ~ "^## \\[" version "\\]" { inside=1; next } inside && /^## \[/ { exit } inside { print }' CHANGELOG.md)"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION" -m "$TAG_BODY"
git push
git push --tags

if [[ -n "${REDMAN_RELEASE_NOTIFY_HELPER:-}" ]]; then
  [[ "$REDMAN_RELEASE_NOTIFY_HELPER" == /* && -x "$REDMAN_RELEASE_NOTIFY_HELPER" ]] \
    || { echo "REDMAN_RELEASE_NOTIFY_HELPER must be an executable absolute path" >&2; exit 1; }
  "$REDMAN_RELEASE_NOTIFY_HELPER" "Released RedMan v$NEW_VERSION. The public bridge was tagged and pushed; no private deployment target was invoked." || true
else
  echo "No REDMAN_RELEASE_NOTIFY_HELPER configured; skipping release notification."
fi
echo "Released RedMan v$NEW_VERSION. Publication is complete; deployment remains an explicit operator action."
