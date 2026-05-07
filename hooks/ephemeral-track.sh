#!/bin/bash
# pokegents ephemeral agent tracker — tracks Claude Code's built-in Agent tool subagents
# Called by SubagentStart, SubagentStop, and PreToolUse(Agent) hook events.
#
# Flow:
#   1. PreToolUse(Agent) → cache prompt/description in pending dir
#   2. SubagentStart → consume pending, POST to dashboard /api/ephemeral
#   3. SubagentStop → PUT to dashboard /api/ephemeral/{id}/complete

# NOTE: No set -e! Hooks must NEVER crash.
trap '' INT  # Ignore SIGINT so Ctrl+C doesn't kill the hook mid-write

POKEGENTS_DATA="${POKEGENTS_DATA:-$HOME/.pokegents}"
EPHEMERAL_DIR="$POKEGENTS_DATA/ephemeral"
PENDING_DIR="$POKEGENTS_DATA/ephemeral-pending"
mkdir -p "$EPHEMERAL_DIR" "$PENDING_DIR"

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || echo "")
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Resolve dashboard URL from config
POKEGENTS_PORT=$(jq -r '.port // 7834' "$POKEGENTS_DATA/config.json" 2>/dev/null || echo "7834")
DASHBOARD_URL="${POKEGENTS_DASHBOARD_URL:-http://localhost:$POKEGENTS_PORT}"

# Resolve parent session ID (prefer stable pokegent_id)
PARENT_SID="${POKEGENT_ID:-${POKEGENTS_SESSION_ID:-$SESSION_ID}}"

# API helper with 2s timeout and silent failure
api_post() {
  local path="$1" body="$2"
  curl -s -X POST "$DASHBOARD_URL$path" \
    -H "Content-Type: application/json" \
    -d "$body" \
    --max-time 2 2>/dev/null || true
}

api_put() {
  local path="$1" body="$2"
  curl -s -X PUT "$DASHBOARD_URL$path" \
    -H "Content-Type: application/json" \
    -d "$body" \
    --max-time 2 2>/dev/null || true
}

case "$EVENT" in
  "PreToolUse")
    # Cache the prompt/description for the upcoming SubagentStart.
    # Tool input has: prompt, description, subagent_type, model
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
    if [ "$TOOL_NAME" != "Agent" ]; then
      exit 0
    fi

    DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // empty' 2>/dev/null || echo "")
    PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty' 2>/dev/null | head -c 500 || echo "")
    SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "general-purpose"' 2>/dev/null || echo "general-purpose")

    # Write to pending dir as a FIFO queue (timestamped files)
    PENDING_SESSION_DIR="$PENDING_DIR/$SESSION_ID"
    mkdir -p "$PENDING_SESSION_DIR" 2>/dev/null
    PENDING_FILE="$PENDING_SESSION_DIR/$(date +%s%N).json"

    jq -n \
      --arg desc "$DESCRIPTION" \
      --arg prompt "$PROMPT" \
      --arg type "$SUBAGENT_TYPE" \
      '{description: $desc, prompt: $prompt, subagent_type: $type}' \
      > "$PENDING_FILE" 2>/dev/null
    ;;

  "SubagentStart")
    AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || echo "")
    AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // "general-purpose"' 2>/dev/null || echo "general-purpose")

    if [ -z "$AGENT_ID" ]; then
      exit 0
    fi

    # Consume oldest pending entry for this session (FIFO)
    DESCRIPTION=""
    PROMPT=""
    PENDING_SESSION_DIR="$PENDING_DIR/$SESSION_ID"
    if [ -d "$PENDING_SESSION_DIR" ]; then
      OLDEST=$(ls -1 "$PENDING_SESSION_DIR"/*.json 2>/dev/null | sort -V | head -1)
      if [ -n "$OLDEST" ] && [ -f "$OLDEST" ]; then
        DESCRIPTION=$(jq -r '.description // empty' "$OLDEST" 2>/dev/null || echo "")
        PROMPT=$(jq -r '.prompt // empty' "$OLDEST" 2>/dev/null || echo "")
        PENDING_TYPE=$(jq -r '.subagent_type // empty' "$OLDEST" 2>/dev/null || echo "")
        [ -n "$PENDING_TYPE" ] && AGENT_TYPE="$PENDING_TYPE"
        rm -f "$OLDEST" 2>/dev/null
      fi
      # Clean up empty dir
      rmdir "$PENDING_SESSION_DIR" 2>/dev/null || true
    fi

    # Use description or generate one from agent_type
    [ -z "$DESCRIPTION" ] && DESCRIPTION="$AGENT_TYPE subagent"

    # Write to filesystem (fallback if API is down)
    jq -n \
      --arg id "$AGENT_ID" \
      --arg type "$AGENT_TYPE" \
      --arg parent "$PARENT_SID" \
      --arg desc "$DESCRIPTION" \
      --arg prompt "$PROMPT" \
      --arg state "running" \
      --arg cwd "$CWD" \
      --arg created "$TIMESTAMP" \
      '{agent_id: $id, agent_type: $type, parent_session_id: $parent, description: $desc, prompt: $prompt, state: $state, cwd: $cwd, created_at: $created}' \
      > "$EPHEMERAL_DIR/$AGENT_ID.json" 2>/dev/null

    # Notify dashboard API
    BODY=$(jq -n \
      --arg id "$AGENT_ID" \
      --arg type "$AGENT_TYPE" \
      --arg parent "$PARENT_SID" \
      --arg desc "$DESCRIPTION" \
      --arg prompt "$PROMPT" \
      --arg cwd "$CWD" \
      '{agent_id: $id, agent_type: $type, parent_session_id: $parent, description: $desc, prompt: $prompt, cwd: $cwd}')
    api_post "/api/ephemeral" "$BODY"
    ;;

  "SubagentStop")
    AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || echo "")
    LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null | head -c 10000 || echo "")
    TRANSCRIPT=$(echo "$INPUT" | jq -r '.agent_transcript_path // empty' 2>/dev/null || echo "")

    if [ -z "$AGENT_ID" ]; then
      exit 0
    fi

    # Update filesystem
    EFILE="$EPHEMERAL_DIR/$AGENT_ID.json"
    if [ -f "$EFILE" ]; then
      jq \
        --arg state "completed" \
        --arg msg "$LAST_MSG" \
        --arg tp "$TRANSCRIPT" \
        --arg completed "$TIMESTAMP" \
        '.state = $state | .last_message = $msg | .transcript_path = $tp | .completed_at = $completed' \
        "$EFILE" > "${EFILE}.tmp" 2>/dev/null && mv "${EFILE}.tmp" "$EFILE" 2>/dev/null
    fi

    # Notify dashboard API
    BODY=$(jq -n \
      --arg msg "$LAST_MSG" \
      --arg tp "$TRANSCRIPT" \
      '{last_message: $msg, transcript_path: $tp}')
    api_put "/api/ephemeral/$AGENT_ID/complete" "$BODY"
    ;;
esac

exit 0
