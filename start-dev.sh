#!/usr/bin/env bash
# Portable start-dev script for macOS/Linux
# Ensures Node.js is available, then starts both servers.

set -e

if ! command -v node &> /dev/null; then
    for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.nvm/versions/node"/*/bin; do
        if [ -x "$dir/node" ]; then
            export PATH="$dir:$PATH"
            break
        fi
    done

    if ! command -v node &> /dev/null; then
        echo "Error: Node.js not found. Install it or update this script." >&2
        exit 1
    fi
fi

cd "$(dirname "$0")/app"
npm run dev
