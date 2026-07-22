#!/usr/bin/env bash
set -euo pipefail

MANIFEST=""
RUNTIMES=()

usage() {
  echo "Usage: verify-breakglass-runtime.sh --manifest PATH --runtime PATH [--runtime PATH ...]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST=${2:-}; shift 2 ;;
    --runtime) RUNTIMES+=("${2:-}"); shift 2 ;;
    *) usage ;;
  esac
done

[[ "$MANIFEST" =~ ^/[A-Za-z0-9._/-]+$ && -f "$MANIFEST" && ! -L "$MANIFEST" ]] || { echo "Plugin manifest is missing or unsafe" >&2; exit 1; }
[[ ${#RUNTIMES[@]} -gt 0 ]] || usage
for runtime in "${RUNTIMES[@]}"; do
  [[ "$runtime" =~ ^/[A-Za-z0-9._/-]+$ && -x "$runtime" && ! -L "$runtime" ]] || { echo "Runtime is missing or unsafe: $runtime" >&2; exit 1; }
  expected=$(awk -v target="$runtime" '
    index($0, "<FILE Name=\"" target "\"") { inside=1; next }
    inside && /<SHA256>/ {
      line=$0
      sub(/^.*<SHA256>/, "", line)
      sub(/<\/SHA256>.*$/, "", line)
      print line
      exit
    }
    inside && /<\/FILE>/ { exit }
  ' "$MANIFEST")
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo "Manifest has no valid SHA-256 for $runtime" >&2; exit 1; }
  actual=$(sha256sum "$runtime" | awk '{print $1}')
  [[ "$actual" == "$expected" ]] || { echo "Runtime hash does not match persistent plugin manifest: $runtime" >&2; exit 1; }
done