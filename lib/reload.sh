_pokegent_reload() {
  local RUNNING_DIR="$POKEGENTS_DATA/running"
  local my_tty=$(tty 2>/dev/null)

  echo "=== Pokegents Reload ==="
  echo ""

  # ── 1. Snapshot all running sessions ──────────────────────────────────
  local -a snap_profiles snap_sids snap_names snap_ttys snap_cpids snap_pids
  for rf in "$RUNNING_DIR"/*.json(N); do
    snap_profiles+=("$(jq -r '.profile' "$rf" 2>/dev/null)")
    snap_sids+=("$(jq -r '.session_id' "$rf" 2>/dev/null)")
    snap_names+=("$(jq -r '.display_name' "$rf" 2>/dev/null)")
    snap_ttys+=("$(jq -r '.tty' "$rf" 2>/dev/null)")
    snap_cpids+=("$(jq -r '.claude_pid // empty' "$rf" 2>/dev/null)")
    snap_pids+=("$(jq -r '.pid // empty' "$rf" 2>/dev/null)")
  done

  local total=${#snap_profiles[@]}
  if [[ $total -eq 0 ]]; then
    echo "No running sessions found."
  else
    echo "Found $total session(s):"
    for ((i=1; i<=total; i++)); do
      local marker=""
      [[ "${snap_ttys[$i]}" == "$my_tty" ]] && marker=" (this session)"
      echo "  ${snap_names[$i]} (${snap_profiles[$i]}) — ${snap_sids[$i]:0:8}$marker"
    done
  fi

  # ── 2. Save snapshot to file for safety ───────────────────────────────
  local snapshot_file="$POKEGENTS_DATA/reload-snapshot.json"
  local entries="[]"
  for ((i=1; i<=total; i++)); do
    entries=$(echo "$entries" | jq \
      --arg p "${snap_profiles[$i]}" \
      --arg s "${snap_sids[$i]}" \
      --arg n "${snap_names[$i]}" \
      '. + [{profile: $p, session_id: $s, display_name: $n}]')
  done
  echo "$entries" > "$snapshot_file"
  echo ""
  echo "Snapshot saved to $snapshot_file"

  # ── 3. Gracefully stop all Claude processes ───────────────────────────
  echo ""
  echo "Stopping sessions..."
  local skipped_self=false

  for ((i=1; i<=total; i++)); do
    local name="${snap_names[$i]}"
    local stty="${snap_ttys[$i]}"
    local cpid="${snap_cpids[$i]}"
    local spid="${snap_pids[$i]}"

    # Skip our own session — we can't kill ourselves
    if [[ -n "$my_tty" && "$stty" == "$my_tty" ]]; then
      echo "  Skipping $name (current session)"
      skipped_self=true
      continue
    fi

    # SIGTERM claude process first (saves state), fall back to shell pid
    local target="${cpid:-$spid}"
    if [[ -n "$target" ]] && kill -0 "$target" 2>/dev/null; then
      echo "  Stopping $name (PID $target)..."
      kill -TERM "$target" 2>/dev/null
    else
      echo "  $name — process already dead"
    fi
  done

  # ── 4. Wait for processes to exit ─────────────────────────────────────
  echo "  Waiting for exit (up to 15s)..."
  local waited=0
  while [[ $waited -lt 15 ]]; do
    local all_done=true
    for ((i=1; i<=total; i++)); do
      [[ -n "$my_tty" && "${snap_ttys[$i]}" == "$my_tty" ]] && continue
      local target="${snap_cpids[$i]:-${snap_pids[$i]}}"
      if [[ -n "$target" ]] && kill -0 "$target" 2>/dev/null; then
        all_done=false
        break
      fi
    done
    [[ "$all_done" == "true" ]] && break
    sleep 1
    ((waited++))
  done

  # Force-kill any stragglers
  for ((i=1; i<=total; i++)); do
    [[ -n "$my_tty" && "${snap_ttys[$i]}" == "$my_tty" ]] && continue
    local target="${snap_cpids[$i]:-${snap_pids[$i]}}"
    if [[ -n "$target" ]] && kill -0 "$target" 2>/dev/null; then
      echo "  Force-killing ${snap_names[$i]}..."
      kill -9 "$target" 2>/dev/null
    fi
  done

  # Give pokegent() cleanup a moment to finish (removes running files, saves history)
  sleep 1

  # ── 5. Close old iTerm tabs ───────────────────────────────────────────
  echo "  Closing old tabs..."
  for ((i=1; i<=total; i++)); do
    [[ -n "$my_tty" && "${snap_ttys[$i]}" == "$my_tty" ]] && continue
    local stty="${snap_ttys[$i]}"
    [[ -z "$stty" ]] && continue
    local safe_tty="${stty//\"/\\\"}"
    osascript -e "
tell application \"iTerm2\"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s = \"$safe_tty\" then
          tell t to close
          return
        end if
      end repeat
    end repeat
  end repeat
end tell" &>/dev/null
  done

  # Clean any leftover running files (pokegent() cleanup should have handled most)
  for ((i=1; i<=total; i++)); do
    [[ -n "$my_tty" && "${snap_ttys[$i]}" == "$my_tty" ]] && continue
    rm -f "$RUNNING_DIR"/${snap_profiles[$i]}-${snap_sids[$i]}.json
  done

  # ── 6. Rebuild dashboard ──────────────────────────────────────────────
  echo ""
  echo "Rebuilding dashboard..."
  if (cd "$POKEGENTS_ROOT/dashboard" && CGO_CFLAGS="-DSQLITE_ENABLE_FTS5" go build -o pokegents-dashboard . 2>&1); then
    echo "  Build successful"
  else
    echo "  Build FAILED — using existing binary"
  fi

  # ── 7. Restart dashboard ──────────────────────────────────────────────
  echo "Restarting dashboard..."
  _pokegent_kill_dashboard
  sleep 0.5
  local dashboard_bin="$POKEGENTS_ROOT/dashboard/pokegents-dashboard"
  if [[ -f "$dashboard_bin" ]]; then
    "$dashboard_bin" serve &>/dev/null &
    disown
    echo "  Dashboard running at http://localhost:$POKEGENTS_PORT"
  else
    echo "  WARNING: Dashboard binary not found"
  fi

  # ── 8. Relaunch sessions in new iTerm tabs ────────────────────────────
  echo ""
  echo "Relaunching sessions..."
  for ((i=1; i<=total; i++)); do
    local profile="${snap_profiles[$i]}"
    local sid="${snap_sids[$i]}"
    local name="${snap_names[$i]}"
    local stty="${snap_ttys[$i]}"

    if [[ -n "$my_tty" && "$stty" == "$my_tty" ]]; then
      echo "  Skipping $name (current session)"
      continue
    fi

    local iterm_prof=$(jq -r '.iterm2_profile // empty' "$PROFILES_DIR/${profile}.json" 2>/dev/null)
    [[ -z "$iterm_prof" ]] && iterm_prof="General"
    echo "  Launching $name ($profile -r ${sid:0:8})..."
    osascript -e "
tell application \"iTerm2\"
  tell current window
    create tab with profile \"$iterm_prof\"
    tell current session of current tab
      write text \"pokegent $profile -r $sid\"
    end tell
  end tell
end tell" &>/dev/null
    sleep 1.5  # Give each session time to start and register
  done

  # ── 9. Summary ────────────────────────────────────────────────────────
  echo ""
  echo "=== Reload complete ==="
  local relaunched=$((total))
  if [[ "$skipped_self" == "true" ]]; then
    relaunched=$((total - 1))
    echo ""
    echo "This session was skipped. To restart it:"
    echo "  Type /exit, then run: pokegent ${POKEGENTS_PROFILE_NAME:-personal} -r ${POKEGENTS_SESSION_ID:-}"
  fi
  echo "Relaunched $relaunched session(s). Snapshot at: $snapshot_file"
}
