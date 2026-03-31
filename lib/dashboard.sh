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
  echo "Legacy profiles:"
  local _found=false
  for f in "$POKEGENTS_DATA/profiles"/*.json(N); do
    _found=true
    local pname=$(basename "$f" .json)
    local emoji=$(jq -r '.emoji' "$f")
    local title=$(jq -r '.title' "$f")
    local cwd=$(jq -r '.cwd' "$f")
    local _shadow=""
    [[ -f "$POKEGENTS_DATA/projects/${pname}.json" ]] && _shadow=" (shadowed by project)"
    printf "  %s %-12s %s  (%s)%s\n" "$emoji" "$pname" "$title" "$cwd" "$_shadow"
  done
  [[ "$_found" == "false" ]] && echo "  (none)"
}

_pokegent_list_projects() {
  echo "Projects:"
  local _found=false
  for f in "$POKEGENTS_DATA/projects"/*.json(N); do
    _found=true
    local pname=$(basename "$f" .json)
    local title=$(jq -r '.title' "$f")
    local cwd=$(jq -r '.cwd' "$f")
    local r=$(jq -r '.color[0]' "$f") g=$(jq -r '.color[1]' "$f") b=$(jq -r '.color[2]' "$f")
    printf "  %-12s %-20s [%s,%s,%s]  %s\n" "$pname" "$title" "$r" "$g" "$b" "$cwd"
  done
  [[ "$_found" == "false" ]] && echo "  (none — create with: pokegent edit project <name>)"
}

_pokegent_list_roles() {
  echo "Roles:"
  local _found=false
  for f in "$POKEGENTS_DATA/roles"/*.json(N); do
    _found=true
    local rname=$(basename "$f" .json)
    local emoji=$(jq -r '.emoji' "$f")
    local title=$(jq -r '.title' "$f")
    printf "  %s %-12s %s\n" "$emoji" "$rname" "$title"
  done
  [[ "$_found" == "false" ]] && echo "  (none — create with: pokegent edit role <name>)"
}

_pokegent_list_all() {
  _pokegent_list_projects
  echo ""
  _pokegent_list_roles
  echo ""
  _pokegent_list_profiles
}
