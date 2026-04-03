#!/bin/bash
# Hook script for protecting RedMan backward compatibility contract files.
# Called by VS Code Copilot's PreToolUse hook before file edits.
# Reads hook input from stdin, checks if the target file is protected.

set -e

INPUT=$(cat)

# Extract the tool name and file path from the hook input
TOOL=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
FILE=$(echo "$INPUT" | grep -o '"filePath"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"filePath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

# Only check file-editing tools
case "$TOOL" in
  create_file|replace_string_in_file|multi_replace_string_in_file|edit_file)
    ;;
  *)
    # Not a file edit — allow
    echo '{"continue": true}'
    exit 0
    ;;
esac

# No file path found — allow
if [ -z "$FILE" ]; then
  echo '{"continue": true}'
  exit 0
fi

# Protected file patterns
PROTECTED=0
REASON=""

case "$FILE" in
  */contracts/v1.json)
    PROTECTED=1
    REASON="v1.json is the immutable backward compatibility contract"
    ;;
  */contracts/v*.json)
    PROTECTED=1
    REASON="Contract version files define the frozen API/DB contract"
    ;;
  */migrations.js)
    # Allow appending new migrations, but flag for review
    if echo "$INPUT" | grep -q '"oldString"'; then
      PROTECTED=1
      REASON="Modifying existing migrations is forbidden — only append new ones"
    fi
    ;;
  */peerApi.js)
    PROTECTED=1
    REASON="Peer API is the highest-protection contract (remote peers depend on it)"
    ;;
esac

if [ "$PROTECTED" = "1" ]; then
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "⚠️ PROTECTED CONTRACT FILE: $REASON. This change may break backward compatibility. Confirm to proceed."
  }
}
EOF
else
  echo '{"continue": true}'
fi
