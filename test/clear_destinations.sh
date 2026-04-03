#!/bin/bash
# Clear test destination directories for RedMan

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"

DIRS=("$DATA_DIR/dest_ssd" "$DATA_DIR/dest_hyper")

for dir in "${DIRS[@]}"; do
  if [ -d "$dir" ]; then
    count=$(find "$dir" -type f | wc -l | tr -d ' ')
    rm -rf "$dir"/*
    echo "✅ Cleared $dir ($count files removed)"
  else
    mkdir -p "$dir"
    echo "📁 Created $dir (didn't exist)"
  fi
done

echo "Done!"
