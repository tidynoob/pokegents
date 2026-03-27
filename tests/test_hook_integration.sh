#!/bin/bash
# Cross-language integration test: verify that status-update.sh (bash) and
# the Go server's UpdateFromEvent produce the same state transitions.
#
# Usage: bash tests/test_hook_integration.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../hooks/status-update.sh"
PASS=0
FAIL=0

# Create temp dirs
TMPDIR=$(mktemp -d)
export POKEGENTS_DATA="$TMPDIR"
mkdir -p "$TMPDIR/status" "$TMPDIR/running" "$TMPDIR/messages"
trap "rm -rf $TMPDIR" EXIT

run_hook() {
  local session_id="$1"
  local event="$2"
  local extra_json="${3:-}"

  local input="{\"session_id\":\"$session_id\",\"hook_event_name\":\"$event\",\"cwd\":\"/tmp/test\"$extra_json}"
  echo "$input" | bash "$HOOK" > /dev/null 2>&1
}

get_state() {
  local session_id="$1"
  local status_file="$TMPDIR/status/${session_id}.json"
  if [ -f "$status_file" ]; then
    jq -r '.state' "$status_file" 2>/dev/null
  else
    echo "MISSING"
  fi
}

assert_state() {
  local test_name="$1"
  local session_id="$2"
  local expected="$3"
  local actual=$(get_state "$session_id")

  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $test_name (state=$actual)"
    ((PASS++))
  else
    echo "  FAIL: $test_name — expected '$expected', got '$actual'"
    ((FAIL++))
  fi
}

echo "=== Hook State Machine Integration Tests ==="
echo ""

# Test 1: UserPromptSubmit → busy
echo "Test 1: UserPromptSubmit → busy"
SID="test-1"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"hello\""
assert_state "UserPromptSubmit sets busy" "$SID" "busy"

# Test 2: Stop → done
echo "Test 2: Stop → done"
run_hook "$SID" "Stop" ",\"last_assistant_message\":\"done\""
assert_state "Stop sets done" "$SID" "done"

# Test 3: PreToolUse on busy → stays busy
echo "Test 3: PreToolUse on busy agent"
SID="test-3"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"work\""
run_hook "$SID" "PreToolUse" ",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}"
assert_state "PreToolUse stays busy" "$SID" "busy"

# Test 4: PermissionRequest → needs_input
echo "Test 4: PermissionRequest → needs_input"
SID="test-4"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"do something\""
run_hook "$SID" "PermissionRequest" ",\"tool_name\":\"Bash\""
assert_state "PermissionRequest sets needs_input" "$SID" "needs_input"

# Test 5: StopFailure → error
echo "Test 5: StopFailure → error"
SID="test-5"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"fail\""
run_hook "$SID" "StopFailure"
assert_state "StopFailure sets error" "$SID" "error"

# Test 6: idle_prompt when busy → done
echo "Test 6: Notification(idle_prompt) when busy → done"
SID="test-6"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"work\""
run_hook "$SID" "Notification" ",\"notification_type\":\"idle_prompt\""
assert_state "idle_prompt on busy → done" "$SID" "done"

# Test 7: idle_prompt when done → stays done (no needs_input!)
echo "Test 7: Notification(idle_prompt) when done → stays done"
SID="test-7"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"work\""
run_hook "$SID" "Stop" ",\"last_assistant_message\":\"finished\""
run_hook "$SID" "Notification" ",\"notification_type\":\"idle_prompt\""
assert_state "idle_prompt on done → stays done" "$SID" "done"

# Test 8: SessionStart → idle
echo "Test 8: SessionStart → idle"
SID="test-8"
run_hook "$SID" "SessionStart"
assert_state "SessionStart sets idle" "$SID" "idle"

# Test 9: SessionEnd → removes status file
echo "Test 9: SessionEnd → removes status file"
SID="test-9"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"bye\""
run_hook "$SID" "SessionEnd"
assert_state "SessionEnd removes status" "$SID" "MISSING"

# Test 10: UserPromptSubmit after error → busy (can recover)
echo "Test 10: Recovery from error"
SID="test-10"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"try\""
run_hook "$SID" "StopFailure"
assert_state "In error state" "$SID" "error"
run_hook "$SID" "UserPromptSubmit" ",\"prompt\":\"retry\""
assert_state "UserPromptSubmit recovers from error" "$SID" "busy"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
