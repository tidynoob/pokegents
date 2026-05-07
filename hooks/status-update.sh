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

# Ignore SIGINT — when user hits Ctrl+C during a tool, the signal propagates to
# the process group and would kill this hook before it can write the status file.
trap '' INT

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

# Runtime gate: if this agent is currently chat-backed (interface=chat in the
# running file), the chat supervisor in the dashboard owns the status file
# pipeline. Running this iterm2-flavored hook for chat agents corrupts state
# — particularly UserPromptSubmit, which gets fired by claude-agent-sdk's
# `--replay-user-messages` on resume and writes a stale "busy" + "processing
# prompt" that nothing later clears (no live Stop event for replayed
# messages). The chat backend's translateUpdate handles status writes for
# chat agents; this script is for iterm2 agents only.
_RT_LOOKUP="${POKEGENT_ID:-${POKEGENTS_SESSION_ID:-$SESSION_ID}}"
if [ -d "$POKEGENTS_DATA/running" ] && [ -n "$_RT_LOOKUP" ]; then
  for _rt_rf in "$POKEGENTS_DATA/running"/*.json; do
    [ -f "$_rt_rf" ] || continue
    _RT_PGID=$(jq -r '.pokegent_id // empty' "$_rt_rf" 2>/dev/null)
    if [ "$_RT_PGID" = "$_RT_LOOKUP" ]; then
      _RT_IFACE=$(jq -r '.interface // empty' "$_rt_rf" 2>/dev/null)
      if [ "$_RT_IFACE" = "chat" ]; then
        exit 0
      fi
      break
    fi
  done
fi

STATE=""
DETAIL=""
SUMMARY=""
TRACE=""
USER_PROMPT=""
BUSY_SINCE=""
CLEAR_OUTPUT=false

# Quick reconciliation: ensure the running file's claude_session_id (session_id field)
# matches Claude's actual SESSION_ID. Files are keyed by pokegent_id (no renames needed).
# Match by POKEGENT_ID env var first (new system), fall back to POKEGENTS_SESSION_ID (legacy).
RUNNING_DIR_CHECK="$POKEGENTS_DATA/running"
POKEGENT_ID_CHECK="${POKEGENT_ID:-${POKEGENTS_SESSION_ID:-}}"
if [ -d "$RUNNING_DIR_CHECK" ] && [ "$EVENT" != "SessionStart" ] && [ "$EVENT" != "SessionEnd" ] && [ -n "$POKEGENT_ID_CHECK" ]; then
  for _rf in "$RUNNING_DIR_CHECK"/*.json; do
    [ -f "$_rf" ] || continue
    _RF_PGID=$(jq -r '.pokegent_id // empty' "$_rf" 2>/dev/null)
    if [ "$_RF_PGID" = "$POKEGENT_ID_CHECK" ]; then
      # Update session_id field to match Claude's actual SESSION_ID (no file rename)
      _RF_SID=$(jq -r '.session_id // empty' "$_rf" 2>/dev/null)
      if [ "$_RF_SID" != "$SESSION_ID" ]; then
        jq --arg sid "$SESSION_ID" '.session_id = $sid' "$_rf" > "${_rf}.tmp" 2>/dev/null && mv "${_rf}.tmp" "$_rf"
      fi
      break
    fi
  done
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
    # Use case-insensitive substring match since Claude Code may send "compact", "/compact",
    # or similar variants in the hook payload.
    if echo "$USER_PROMPT" | grep -qi "^/?compact$"; then
      DETAIL="compacting"
    else
      DETAIL="processing prompt"
      CLEAR_OUTPUT=true
    fi
    # Reset message budget for this agent's turn. Mailboxes are keyed by
    # pokegent_id (stable across resume/migration). Fall back to legacy IDs
    # only for old running files that pre-date the pokegent_id refactor.
    BUDGET_LOOKUP="${POKEGENT_ID:-${POKEGENTS_SESSION_ID:-$SESSION_ID}}"
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
    DETAIL="finished"
    # Check if this was a /compact FIRST — last_assistant_message often contains
    # the previous turn's message, not the compaction summary, so PREV_DETAIL wins.
    _STOP_STATUS="$STATUS_DIR/${SESSION_ID}.json"
    if [ -f "$_STOP_STATUS" ]; then
      PREV_DETAIL=$(jq -r '.detail // ""' "$_STOP_STATUS" 2>/dev/null || echo "")
      if [ "$PREV_DETAIL" = "compacting" ]; then
        SUMMARY="Compacted"
      fi
    fi
    # Only fall back to last_assistant_message when not a compact
    if [ -z "$SUMMARY" ]; then
      SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null | head -c 2000 || echo "")
    fi
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
    # Detect compaction via transcript: check if a compact_boundary marker appears
    # near the end of the transcript (written by Claude Code on every /compact).
    # This fires right after /compact completes regardless of whether UserPromptSubmit
    # fired — it's the most reliable compact detection available.
    if [ -z "$STATE" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
      if tail -c 65536 "$TRANSCRIPT" 2>/dev/null | grep -q '"compact_boundary"'; then
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
    # Use POKEGENT_ID (new stable ID) with fallback to POKEGENTS_SESSION_ID (legacy)
    PGID="${POKEGENT_ID:-${POKEGENTS_SESSION_ID:-}}"

    # Find Claude's PID from session registry
    CLAUDE_PID=""
    for spf in "$HOME/.claude/sessions"/*.json; do
      [ -f "$spf" ] || continue
      SPF_SID=$(jq -r '.sessionId // empty' "$spf" 2>/dev/null)
      if [ "$SPF_SID" = "$SESSION_ID" ]; then
        CLAUDE_PID=$(jq -r '.pid // empty' "$spf" 2>/dev/null)
        break
      fi
    done

    # Find matching running file — 1-pass match by pokegent_id (no file renames needed)
    # Files are now named {profile}-{pokegent_id}.json — stable, never renamed.
    if [ -d "$RUNNING_DIR" ]; then
      MATCHED_RF=""

      if [ -n "$PGID" ]; then
        # Primary: match pokegent_id field (new system)
        for rf in "$RUNNING_DIR"/*.json; do
          [ -f "$rf" ] || continue
          RF_PGID=$(jq -r '.pokegent_id // empty' "$rf" 2>/dev/null)
          if [ "$RF_PGID" = "$PGID" ]; then
            MATCHED_RF="$rf"
            break
          fi
        done
      fi

      # Legacy fallback: match by session_id field (only if no POKEGENT_ID env var)
      if [ -z "$MATCHED_RF" ] && [ -z "$PGID" ]; then
        for rf in "$RUNNING_DIR"/*.json; do
          [ -f "$rf" ] || continue
          RF_SID=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
          if [ "$RF_SID" = "$SESSION_ID" ]; then
            MATCHED_RF="$rf"
            break
          fi
        done
      fi

      if [ -n "$MATCHED_RF" ]; then
        # Update claude_pid and session_id (Claude's conversation ID) — NO file rename
        _UPDATES=""
        if [ -n "$CLAUDE_PID" ]; then
          _UPDATES="$_UPDATES | .claude_pid = $CLAUDE_PID"
        fi
        RF_SID=$(jq -r '.session_id // empty' "$MATCHED_RF" 2>/dev/null)
        if [ "$RF_SID" != "$SESSION_ID" ]; then
          _UPDATES="$_UPDATES | .session_id = \"$SESSION_ID\""
        fi
        if [ -n "$_UPDATES" ]; then
          jq "${_UPDATES# | }" "$MATCHED_RF" > "${MATCHED_RF}.tmp" 2>/dev/null && mv "${MATCHED_RF}.tmp" "$MATCHED_RF"
        fi
      fi
    fi
    # NOTE: Do NOT re-enable set -e. The rest of the hook (status write,
    # activity log, message delivery) must also be crash-resilient.
    ;;
  "SessionEnd")
    # Clean up status + running files. Try pokegent_id first (new system), fall back to session_id.
    # Guard: subagent SessionEnd events inherit POKEGENT_ID but have a different
    # SESSION_ID. Only clean the pokegent-keyed status if the session matches.
    _PGID_END="${POKEGENT_ID:-${POKEGENTS_SESSION_ID:-}}"
    if [ -n "$_PGID_END" ]; then
      _STATUS_SID=$(jq -r '.session_id // empty' "$STATUS_DIR/${_PGID_END}.json" 2>/dev/null)
      if [ "$_STATUS_SID" = "$SESSION_ID" ] || [ -z "$_STATUS_SID" ]; then
        rm -f "$STATUS_DIR/${_PGID_END}.json"
      fi
    fi
    rm -f "$STATUS_DIR/${SESSION_ID}.json"
    RUNNING_DIR="$POKEGENTS_DATA/running"
    # Clean running files — but ONLY if WE still own them. If a dashboard
    # interface migration flipped the file to interface=chat, the chat
    # backend owns it now and we must not delete (otherwise the agent
    # vanishes from the dashboard mid-migration). Same idea as
    # pokegent.sh's ownership check at the shell-exit level.
    if [ -n "$_PGID_END" ]; then
      for rf in "$RUNNING_DIR"/*.json; do
        [ -f "$rf" ] || continue
        _RF_PG=$(jq -r '.pokegent_id // empty' "$rf" 2>/dev/null)
        if [ "$_RF_PG" = "$_PGID_END" ]; then
          _RF_IFACE=$(jq -r '.interface // empty' "$rf" 2>/dev/null)
          if [ "$_RF_IFACE" = "chat" ]; then
            break
          fi
          # Only delete if the ending session matches the running file's session.
          # Subagent SessionEnd events inherit POKEGENT_ID but have a different
          # SESSION_ID — deleting on those would kill the parent agent's card.
          _RF_SID=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
          if [ "$_RF_SID" = "$SESSION_ID" ]; then
            rm -f "$rf"
          fi
          break
        fi
      done
    fi
    # Legacy fallback: remove by session_id filename pattern (also skip if
    # the file is chat-owned).
    for rf in "$RUNNING_DIR"/*-"${SESSION_ID}".json; do
      [ -f "$rf" ] || continue
      _RF_IFACE=$(jq -r '.interface // empty' "$rf" 2>/dev/null)
      if [ "$_RF_IFACE" = "chat" ]; then
        continue
      fi
      rm -f "$rf"
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
# Status file keyed by pokegent_id (new) or SESSION_ID (legacy fallback)
_STATUS_KEY="${POKEGENT_ID:-${POKEGENTS_SESSION_ID:-$SESSION_ID}}"
STATUS_FILE="$STATUS_DIR/${_STATUS_KEY}.json"
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

  # Output activity overlap warning if any
  if [ -n "$NOTIFY" ]; then
    FORMATTED=$(printf '%b' "$NOTIFY")
    jq -n --arg msg "$FORMATTED" '{systemMessage: $msg}'
    exit 0
  fi
fi

exit 0
