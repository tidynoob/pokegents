_pokegent_kill_dashboard() {
  # Kill by port since the binary may run as "main" or "pokegents-dashboard"
  local pids=$(lsof -ti :${POKEGENTS_PORT:-7834} 2>/dev/null)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null
    # Wait for port to actually free up
    local i=0
    while lsof -ti :${POKEGENTS_PORT:-7834} &>/dev/null && [[ $i -lt 10 ]]; do
      sleep 0.5
      ((i++))
    done
  fi
}

_pokegent_list_profiles() {
  echo "Available profiles:"
  for f in "$POKEGENTS_DATA/profiles"/*.json(N); do
    local pname=$(basename "$f" .json)
    local emoji=$(jq -r '.emoji' "$f")
    local title=$(jq -r '.title' "$f")
    local cwd=$(jq -r '.cwd' "$f")
    printf "  %s %-12s %s  (%s)\n" "$emoji" "$pname" "$title" "$cwd"
  done
}
