#!/bin/bash
# pokegents status hook — writes structured status to $POKEGENTS_DATA/status/
#
# State machine:
#   idle        — just started/resumed, no work yet (grey)
#   busy        — user sent a message, agent is working (yellow)
#   done        — agent finished its turn, waiting for next prompt (green)
#   needs_input — agent needs permission or user response (red)

# NOTE: No set -e! Hooks must NEVER crash — a broken hook blocks all Claude operations.
# Every command that can fail uses 2>/dev/null || fallback instead.

POKEGENTS_DATA="${POKEGENTS_DATA:-$HOME/.pokegents}"
STATUS_DIR="$POKEGENTS_DATA/status"
mkdir -p "$STATUS_DIR"

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || echo "")
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || echo "")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

STATE=""
DETAIL=""
SUMMARY=""
TRACE=""
USER_PROMPT=""
BUSY_SINCE=""
CLEAR_OUTPUT=false

# Quick reconciliation: if no running file exists for this session ID, try matching
# by POKEGENTS_SESSION_ID and patch it. This handles --fork-session where SessionStart
# may not fire but other events do.
# IMPORTANT: Only match by ccd_session_id field, NOT by session_id field.
# Matching by session_id would steal the original agent's file when cloning.
RUNNING_DIR_CHECK="$POKEGENTS_DATA/running"
if [ -d "$RUNNING_DIR_CHECK" ] && [ "$EVENT" != "SessionStart" ] && [ "$EVENT" != "SessionEnd" ]; then
  HAS_RF=false
  for _rf in "$RUNNING_DIR_CHECK"/*-"${SESSION_ID}".json; do
    [ -f "$_rf" ] && HAS_RF=true && break
  done
  if [ "$HAS_RF" = "false" ]; then
    POKEGENTS_SID_CHECK="${POKEGENTS_SESSION_ID:-}"
    if [ -n "$POKEGENTS_SID_CHECK" ]; then
      for _rf in "$RUNNING_DIR_CHECK"/*.json; do
        [ -f "$_rf" ] || continue
        _RF_CCD=$(jq -r '.ccd_session_id // empty' "$_rf" 2>/dev/null)
        if [ "$_RF_CCD" = "$POKEGENTS_SID_CHECK" ]; then
          # Rename to match SESSION_ID — but only if no collision
          _RF_PROF=$(jq -r '.profile // "unknown"' "$_rf" 2>/dev/null)
          _NEW_RF="$RUNNING_DIR_CHECK/${_RF_PROF}-${SESSION_ID}.json"
          if [ "$_rf" != "$_NEW_RF" ] && [ ! -f "$_NEW_RF" ]; then
            jq --arg sid "$SESSION_ID" '.session_id = $sid' "$_rf" > "${_rf}.tmp" && mv "${_rf}.tmp" "$_rf"
            mv "$_rf" "$_NEW_RF"
          fi
          # If collision (another agent owns that session_id), leave file untouched
          break
        fi
      done
    fi
  fi
fi

extract_trace() {
  if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
    return
  fi
  # Extract last assistant text block from transcript tail (jq, no python3)
  TRACE=$(tail -50 "$TRANSCRIPT" | while IFS= read -r line; do
    echo "$line" | jq -r '
      select(.type == "assistant") |
      .message.content // [] | if type == "array" then . else [] end |
      map(select(.type == "text") | .text // "") |
      last // empty
    ' 2>/dev/null
  done | tail -1 | head -c 200 || echo "")
}

case "$EVENT" in
  "UserPromptSubmit")
    USER_PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null | head -c 200 || echo "")
    STATE="busy"
    BUSY_SINCE="$TIMESTAMP"
    # Slash commands like /compact don't produce assistant output — preserve previous output
    if [ "$USER_PROMPT" = "compact" ] || [ "$USER_PROMPT" = "/compact" ]; then
      DETAIL="compacting"
    else
      DETAIL="processing prompt"
      CLEAR_OUTPUT=true
    fi
    # Reset message budget for this agent's turn (use POKEGENTS_SESSION_ID for clone safety)
    BUDGET_LOOKUP="${POKEGENTS_SESSION_ID:-$SESSION_ID}"
    BUDGET_FILE="$POKEGENTS_DATA/messages/${BUDGET_LOOKUP}/_msg_budget"
    mkdir -p "$POKEGENTS_DATA/messages/${BUDGET_LOOKUP}" 2>/dev/null
    echo "0" > "$BUDGET_FILE" 2>/dev/null
    ;;
  "PreToolUse")
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
    TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input | if type == "object" then ((.command // .file_path // .pattern // .query // (.description // "")) | tostring) else tostring end' 2>/dev/null || echo "")
    STATE="busy"
    DETAIL="$TOOL: $(echo "$TOOL_INPUT" | head -c 80)"
    extract_trace
    ;;
  "PostToolUse")
    STATE="busy"
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
    DETAIL="completed $TOOL"
    extract_trace
    ;;
  "PostToolUseFailure")
    STATE="busy"
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
    DETAIL="$TOOL failed"
    extract_trace
    ;;
  "StopFailure")
    STATE="error"
    DETAIL="API error — reprompt to retry"
    ;;
  "Stop")
    STATE="done"
    SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null | head -c 200 || echo "")
    # If Stop fires after /compact with no assistant message, show "Compacted"
    if [ -z "$SUMMARY" ]; then
      STATUS_FILE="$STATUS_DIR/${SESSION_ID}.json"
      if [ -f "$STATUS_FILE" ]; then
        PREV_DETAIL=$(jq -r '.detail // ""' "$STATUS_FILE" 2>/dev/null || echo "")
        if [ "$PREV_DETAIL" = "compacting" ]; then
          SUMMARY="Compacted"
        fi
      fi
    fi
    DETAIL="finished"
    ;;
  "PermissionRequest")
    STATE="needs_input"
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
    DETAIL="needs permission for $TOOL"
    ;;
  "Notification")
    NOTIF_TYPE=$(echo "$INPUT" | jq -r '.notification_type // ""' 2>/dev/null || echo "")
    if [ "$NOTIF_TYPE" = "idle_prompt" ]; then
      STATUS_FILE="$STATUS_DIR/${SESSION_ID}.json"
      CURRENT_STATE=""
      CURRENT_DETAIL=""
      if [ -f "$STATUS_FILE" ]; then
        CURRENT_STATE=$(jq -r '.state // ""' "$STATUS_FILE" 2>/dev/null || echo "")
        CURRENT_DETAIL=$(jq -r '.detail // ""' "$STATUS_FILE" 2>/dev/null || echo "")
      fi
      # idle_prompt only transitions busy → done (never sets needs_input;
      # that's exclusively for PermissionRequest)
      if [ "$CURRENT_STATE" = "busy" ]; then
        STATE="done"
        DETAIL="finished"
        BUSY_SINCE=""
        # If this was a /compact, set summary to "Compacted"
        if [ "$CURRENT_DETAIL" = "compacting" ]; then
          SUMMARY="Compacted"
        fi
      fi
    fi
    ;;
  "SessionStart")
    PREV_STATUS_FILE="$STATUS_DIR/${SESSION_ID}.json"
    if [ -f "$PREV_STATUS_FILE" ]; then
      PREV_STATE=$(jq -r '.state // ""' "$PREV_STATUS_FILE" 2>/dev/null || echo "")
      PREV_DETAIL=$(jq -r '.detail // ""' "$PREV_STATUS_FILE" 2>/dev/null || echo "")
      PREV_SUMMARY=$(jq -r '.last_summary // ""' "$PREV_STATUS_FILE" 2>/dev/null || echo "")

      # If this session is already active (busy), don't overwrite with idle.
      # This happens when a clone does --resume <our-session-id> — Claude fires
      # SessionStart for the original session ID even though it's still running.
      if [ "$PREV_STATE" = "busy" ]; then
        # Skip status update entirely — just do running file reconciliation below
        STATE="SKIP"
      # If compacting/compacted, preserve it
      elif [ "$PREV_DETAIL" = "compacting" ] || [ "$PREV_SUMMARY" = "Compacted" ]; then
        STATE="done"
        DETAIL="finished"
        SUMMARY="Compacted"
      fi
    fi
    if [ -z "$STATE" ]; then
      STATE="idle"
      DETAIL="session started"
    fi
    # Disable errexit for the reconciliation block — individual jq failures
    # shouldn't abort the whole hook
    set +e
    RUNNING_DIR="$POKEGENTS_DATA/running"
    POKEGENTS_SID="${POKEGENTS_SESSION_ID:-}"

    # Find Claude's PID from session registry
    CLAUDE_PID=""
    CLAUDE_TTY=""
    for spf in "$HOME/.claude/sessions"/*.json; do
      [ -f "$spf" ] || continue
      SPF_SID=$(jq -r '.sessionId // empty' "$spf" 2>/dev/null)
      if [ "$SPF_SID" = "$SESSION_ID" ]; then
        CLAUDE_PID=$(jq -r '.pid // empty' "$spf" 2>/dev/null)
        # Get TTY from the PID
        if [ -n "$CLAUDE_PID" ]; then
          CLAUDE_TTY=$(ps -p "$CLAUDE_PID" -o tty= 2>/dev/null | sed 's/^/\/dev\//' || echo "")
        fi
        break
      fi
    done

    # Find matching running file using priority passes:
    # Pass 1: POKEGENTS_SESSION_ID (most specific — handles fork/clone correctly)
    # Pass 2: exact session_id match
    # Pass 3: TTY fallback (only if no better match found)
    # Separate passes prevent TTY collisions from stealing another agent's file.
    if [ -d "$RUNNING_DIR" ]; then
      MATCHED_RF=""

      # Pass 1: POKEGENTS_SESSION_ID — match ONLY against ccd_session_id field
      # Do NOT match against session_id to avoid stealing the original agent's
      # file when cloning (the clone's POKEGENTS_SID could match the original's session_id)
      if [ -z "$MATCHED_RF" ] && [ -n "$POKEGENTS_SID" ]; then
        for rf in "$RUNNING_DIR"/*.json; do
          [ -f "$rf" ] || continue
          RF_POKEGENTS_SID=$(jq -r '.ccd_session_id // empty' "$rf" 2>/dev/null)
          if [ "$RF_POKEGENTS_SID" = "$POKEGENTS_SID" ]; then
            MATCHED_RF="$rf"
            break
          fi
        done
      fi

      # Pass 2: exact session_id (only if no POKEGENTS_SESSION_ID — legacy fallback)
      # When POKEGENTS_SESSION_ID is set, skip this pass to avoid stealing the original
      # agent's file during --fork-session (clone has POKEGENTS_SID but SESSION_ID may
      # match the original's running file)
      if [ -z "$MATCHED_RF" ] && [ -z "$POKEGENTS_SID" ]; then
        for rf in "$RUNNING_DIR"/*.json; do
          [ -f "$rf" ] || continue
          RF_SID=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
          if [ "$RF_SID" = "$SESSION_ID" ]; then
            MATCHED_RF="$rf"
            break
          fi
        done
      fi

      # Pass 3: TTY fallback (only if no POKEGENTS_SESSION_ID and no exact match)
      if [ -z "$MATCHED_RF" ] && [ -z "$POKEGENTS_SID" ] && [ -n "$CLAUDE_TTY" ]; then
        for rf in "$RUNNING_DIR"/*.json; do
          [ -f "$rf" ] || continue
          RF_TTY=$(jq -r '.tty // empty' "$rf" 2>/dev/null)
          if [ "$RF_TTY" = "$CLAUDE_TTY" ]; then
            MATCHED_RF="$rf"
            break
          fi
        done
      fi

      if [ -n "$MATCHED_RF" ]; then
        # Write claude_pid
        if [ -n "$CLAUDE_PID" ]; then
          jq --argjson cpid "$CLAUDE_PID" '.claude_pid = $cpid' "$MATCHED_RF" > "${MATCHED_RF}.tmp" && mv "${MATCHED_RF}.tmp" "$MATCHED_RF"
        fi
        # Patch session_id and rename file — but ONLY if the target doesn't already
        # exist as another agent's file. Clones share the same conversation session_id
        # as the original, so renaming would overwrite the original's running file.
        RF_PROFILE=$(jq -r '.profile // "unknown"' "$MATCHED_RF" 2>/dev/null)
        NEW_RF="$RUNNING_DIR/${RF_PROFILE}-${SESSION_ID}.json"
        if [ "$MATCHED_RF" = "$NEW_RF" ]; then
          # Already correct filename — just patch session_id if needed
          RF_SID=$(jq -r '.session_id // empty' "$MATCHED_RF" 2>/dev/null)
          if [ "$RF_SID" != "$SESSION_ID" ]; then
            jq --arg sid "$SESSION_ID" '.session_id = $sid' "$MATCHED_RF" > "${MATCHED_RF}.tmp" && mv "${MATCHED_RF}.tmp" "$MATCHED_RF"
          fi
        elif [ -f "$NEW_RF" ]; then
          # Target file exists (another agent owns that session_id) — DON'T rename
          # AND don't patch session_id. Two files with the same session_id causes
          # map collisions in the dashboard. The clone keeps its ccd_session_id as
          # its identity; status updates use the status file (keyed by SESSION_ID).
          : # no-op — leave the file untouched
        else
          # Safe to rename — no collision
          jq --arg sid "$SESSION_ID" '.session_id = $sid' "$MATCHED_RF" > "${MATCHED_RF}.tmp" && mv "${MATCHED_RF}.tmp" "$MATCHED_RF"
          mv "$MATCHED_RF" "$NEW_RF"
        fi
      fi
    fi
    # NOTE: Do NOT re-enable set -e. The rest of the hook (status write,
    # activity log, message delivery) must also be crash-resilient.
    ;;
  "SessionEnd")
    STATUS_FILE="$STATUS_DIR/${SESSION_ID}.json"
    rm -f "$STATUS_FILE"
    RUNNING_DIR="$POKEGENTS_DATA/running"
    for rf in "$RUNNING_DIR"/*-"${SESSION_ID}".json; do
      [ -f "$rf" ] && rm -f "$rf"
    done
    exit 0
    ;;
  *)
    exit 0
    ;;
esac

if [ -z "$STATE" ] || [ "$STATE" = "SKIP" ]; then
  exit 0
fi

# Guard against race conditions: a slow PreToolUse/PostToolUse hook that finishes
# after a Stop hook should NOT overwrite "done" with "busy".
# Only UserPromptSubmit can transition out of done/error.
STATUS_FILE="$STATUS_DIR/${SESSION_ID}.json"
if [ -f "$STATUS_FILE" ] && [ "$STATE" = "busy" ] && [ "$EVENT" != "UserPromptSubmit" ]; then
  CURRENT_FILE_STATE=$(jq -r '.state // ""' "$STATUS_FILE" 2>/dev/null || echo "")
  if [ "$CURRENT_FILE_STATE" = "done" ] || [ "$CURRENT_FILE_STATE" = "error" ] || [ "$CURRENT_FILE_STATE" = "idle" ]; then
    exit 0
  fi
fi

EXISTING_ACTIONS="[]"
if [ -f "$STATUS_FILE" ]; then
  if [ "$CLEAR_OUTPUT" = "true" ]; then
    # New prompt: keep user_prompt but clear output fields
    [ -z "$USER_PROMPT" ] && USER_PROMPT=$(jq -r '.user_prompt // ""' "$STATUS_FILE" 2>/dev/null || echo "")
  else
    [ -z "$SUMMARY" ] && SUMMARY=$(jq -r '.last_summary // ""' "$STATUS_FILE" 2>/dev/null || echo "")
    [ -z "$TRACE" ] && TRACE=$(jq -r '.last_trace // ""' "$STATUS_FILE" 2>/dev/null || echo "")
    [ -z "$USER_PROMPT" ] && USER_PROMPT=$(jq -r '.user_prompt // ""' "$STATUS_FILE" 2>/dev/null || echo "")
    EXISTING_ACTIONS=$(jq -c '.recent_actions // []' "$STATUS_FILE" 2>/dev/null || echo "[]")
    # Preserve busy_since from previous state (only UserPromptSubmit sets it fresh)
    [ -z "$BUSY_SINCE" ] && BUSY_SINCE=$(jq -r '.busy_since // ""' "$STATUS_FILE" 2>/dev/null || echo "")
  fi
fi

# Build recent_actions: append on tool use, clear on stop/new prompt
ACTIONS="$EXISTING_ACTIONS"
case "$EVENT" in
  "PreToolUse"|"PostToolUseFailure")
    ACTIONS=$(echo "$ACTIONS" | jq --arg a "$DETAIL" '(. + [$a])[-6:]' 2>/dev/null || echo "[]")
    ;;
  "Stop"|"StopFailure"|"SessionStart")
    ACTIONS="[]"
    BUSY_SINCE=""
    ;;
  "UserPromptSubmit")
    ACTIONS="[]"
    ;;
esac

# Write status file — if jq fails, write a minimal fallback so dashboard still works
if ! jq -n \
  --arg session_id "$SESSION_ID" \
  --arg state "$STATE" \
  --arg detail "$DETAIL" \
  --arg cwd "$CWD" \
  --arg timestamp "$TIMESTAMP" \
  --arg busy_since "$BUSY_SINCE" \
  --arg last_summary "$SUMMARY" \
  --arg last_trace "$TRACE" \
  --arg user_prompt "$USER_PROMPT" \
  --argjson recent_actions "${ACTIONS:-[]}" \
  '{session_id: $session_id, state: $state, detail: $detail, cwd: $cwd, timestamp: $timestamp, busy_since: $busy_since, last_summary: $last_summary, last_trace: $last_trace, user_prompt: $user_prompt, recent_actions: $recent_actions}' > "$STATUS_FILE" 2>/dev/null; then
  # Fallback: write minimal valid JSON so dashboard doesn't lose this agent
  echo "{\"session_id\":\"$SESSION_ID\",\"state\":\"$STATE\",\"detail\":\"$DETAIL\",\"cwd\":\"$CWD\",\"timestamp\":\"$TIMESTAMP\"}" > "$STATUS_FILE"
fi

# ── Activity log ──────────────────────────────────────────────────────────
# Shared append-only log so agents know what others changed.
# Stored per-project at ~/.pokegents/activity/{project_hash}.log
ACTIVITY_DIR="$POKEGENTS_DATA/activity"
LASTREAD_DIR="$POKEGENTS_DATA/activity-lastread"
PROJECT_HASH=""
if [ -n "$CWD" ]; then
  PROJECT_HASH=$(echo "$CWD" | sed 's|/|-|g; s|^-||' 2>/dev/null || echo "default")
fi
ACTIVITY_LOG="$ACTIVITY_DIR/${PROJECT_HASH}.log"

# On Stop: append a 1-liner with changed files + summary
if [ "$EVENT" = "Stop" ] && [ -n "$PROJECT_HASH" ]; then
  mkdir -p "$ACTIVITY_DIR" 2>/dev/null
  # Extract file paths from EXISTING_ACTIONS (captured before Stop cleared them)
  CHANGED_FILES=""
  if [ -n "$EXISTING_ACTIONS" ] && [ "$EXISTING_ACTIONS" != "[]" ]; then
    CHANGED_FILES=$(echo "$EXISTING_ACTIONS" | jq -r '
      [.[] |
        capture("(?<tool>Edit|Write): (?<p>[^ ]+)") |
        select(.p | startswith("/")) |
        "edited " + (.p | ltrimstr("'"$CWD"'/") | ltrimstr("'"$CWD"'"))
      ] | unique | join(", ")' 2>/dev/null || echo "")
  fi
  # Get display name from running file
  AGENT_NAME=""
  for _rf in "$POKEGENTS_DATA/running"/*-"${SESSION_ID}".json; do
    [ -f "$_rf" ] && AGENT_NAME=$(jq -r '.display_name // empty' "$_rf" 2>/dev/null) && break
  done
  [ -z "$AGENT_NAME" ] && AGENT_NAME="${POKEGENTS_PROFILE_NAME:-unknown}"
  # Build log entry
  LOG_SUMMARY=$(echo "$SUMMARY" | head -c 120 | tr '\n' ' ')
  if [ -n "$CHANGED_FILES" ]; then
    echo "[$TIMESTAMP] [$SESSION_ID] [$AGENT_NAME] $CHANGED_FILES" >> "$ACTIVITY_LOG" 2>/dev/null
  fi
  # Rotate if log exceeds 500 lines
  LOG_LINES=$(wc -l < "$ACTIVITY_LOG" 2>/dev/null | tr -d ' ' || echo "0")
  if [ "$LOG_LINES" -gt 500 ]; then
    tail -200 "$ACTIVITY_LOG" > "${ACTIVITY_LOG}.tmp" && mv "${ACTIVITY_LOG}.tmp" "$ACTIVITY_LOG"
  fi
fi

# On UserPromptSubmit: inject recent activity from OTHER agents + pending messages
if [ "$EVENT" = "UserPromptSubmit" ]; then
  NOTIFY=""

  # Part 1: Activity log — only notify about file overlaps (not the full dump)
  if [ -f "$ACTIVITY_LOG" ] && [ -f "$STATUS_FILE" ]; then
    mkdir -p "$LASTREAD_DIR" 2>/dev/null
    LASTREAD_FILE="$LASTREAD_DIR/${SESSION_ID}"
    LAST_LINE=0
    [ -f "$LASTREAD_FILE" ] && LAST_LINE=$(cat "$LASTREAD_FILE" 2>/dev/null | grep -o '^[0-9]*' || echo "0")
    [ -z "$LAST_LINE" ] && LAST_LINE=0
    TOTAL_LINES=$(wc -l < "$ACTIVITY_LOG" 2>/dev/null | tr -d ' ' || echo "0")
    if [ "$TOTAL_LINES" -gt "$LAST_LINE" ]; then
      NEW_ENTRIES=$(tail -n +"$((LAST_LINE + 1))" "$ACTIVITY_LOG" 2>/dev/null | grep -v "\[$SESSION_ID\]" | tail -3)
      # Only inject if there are file overlaps with our recent work
      MY_FILES=$(jq -r '[.recent_actions // [] | .[] | capture("(?:Read|Edit|Write): (?<p>[^ ]+)") | .p] | unique | .[]' "$STATUS_FILE" 2>/dev/null || echo "")
      if [ -n "$MY_FILES" ] && [ -n "$NEW_ENTRIES" ]; then
        OVERLAPS=""
        while IFS= read -r entry; do
          for mf in $MY_FILES; do
            mf_rel="${mf#$CWD/}"
            if echo "$entry" | grep -qF "$mf_rel" 2>/dev/null; then
              OVERLAPS="${OVERLAPS}${OVERLAPS:+\n}$entry"
              break
            fi
          done
        done <<< "$NEW_ENTRIES"
        [ -n "$OVERLAPS" ] && NOTIFY="⚠ Other agents modified files you're working on:\n$OVERLAPS"
      fi
    fi
    echo "$TOTAL_LINES" > "$LASTREAD_FILE" 2>/dev/null
  fi

  # Part 2: Pending messages — deliver via dashboard API (fast path) or file fallback
  # Use POKEGENTS_SESSION_ID (unique per agent, even for clones) not SESSION_ID (shared by clones)
  DASHBOARD_URL="${POKEGENTS_DASHBOARD_URL:-http://localhost:7834}"
  MSG_LOOKUP_ID="${POKEGENTS_SESSION_ID:-$SESSION_ID}"
  MSG_CONTENT=""

  # Fast path: try dashboard API (marks delivered + returns content)
  DELIVERED=$(curl -s -m 2 -X POST "$DASHBOARD_URL/api/messages/deliver/$MSG_LOOKUP_ID" 2>/dev/null || echo "FAIL")
  if [ "$DELIVERED" != "FAIL" ]; then
    MSG_COUNT=$(echo "$DELIVERED" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo "0")
    if [ "$MSG_COUNT" -gt 0 ]; then
      # Format with jq (no python3 dependency)
      MSG_CONTENT=$(echo "$DELIVERED" | jq -r '.[] | "[Message from \(.from_name)]: \(.content)"' 2>/dev/null | paste -sd '\n---\n' - || echo "")
    fi
  else
    # File fallback: read messages directly from mailbox (dashboard may be down)
    MAILBOX="$POKEGENTS_DATA/messages/$MSG_LOOKUP_ID"
    if [ -d "$MAILBOX" ]; then
      for msgfile in "$MAILBOX"/*.json; do
        [ -f "$msgfile" ] || continue
        [ "$(basename "$msgfile")" = "_msg_budget" ] && continue
        IS_DELIVERED=$(jq -r '.delivered // false' "$msgfile" 2>/dev/null || echo "false")
        [ "$IS_DELIVERED" = "true" ] && continue
        FROM_NAME=$(jq -r '.from_name // "unknown"' "$msgfile" 2>/dev/null || echo "unknown")
        CONTENT=$(jq -r '.content // ""' "$msgfile" 2>/dev/null || echo "")
        if [ -n "$CONTENT" ]; then
          [ -n "$MSG_CONTENT" ] && MSG_CONTENT="${MSG_CONTENT}\n---\n"
          MSG_CONTENT="${MSG_CONTENT}[Message from ${FROM_NAME}]: ${CONTENT}"
          # Mark delivered
          jq '.delivered = true' "$msgfile" > "${msgfile}.tmp" && mv "${msgfile}.tmp" "$msgfile" 2>/dev/null
        fi
      done
    fi
  fi

  if [ -n "$MSG_CONTENT" ]; then
    NOTIFY="${NOTIFY}${NOTIFY:+\n\n}$MSG_CONTENT"
  fi

  # Output combined systemMessage
  if [ -n "$NOTIFY" ]; then
    FORMATTED=$(printf '%b' "$NOTIFY")
    jq -n --arg msg "$FORMATTED" '{systemMessage: $msg}'
    exit 0
  fi
fi

exit 0
