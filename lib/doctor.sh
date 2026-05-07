_pokegent_doctor() {
  local ok=0 warn=0 fail=0

  _doc_ok()   { echo "  ✓ $1"; ((ok++)); return 0; }
  _doc_warn() { echo "  · $1"; ((warn++)); return 0; }
  _doc_fail() { echo "  ✗ $1"; ((fail++)); return 0; }

  echo "=== Pokegents Doctor ==="
  echo ""

  # ── Dependencies ──
  echo "Dependencies:"
  for dep in jq curl python3; do
    command -v "$dep" &>/dev/null && _doc_ok "$dep" || _doc_fail "$dep (required)"
  done
  for dep in node npm; do
    command -v "$dep" &>/dev/null && _doc_ok "$dep" || _doc_warn "$dep (needed for MCP messaging)"
  done
  command -v go &>/dev/null && _doc_ok "go" || _doc_warn "go (needed for dashboard build)"
  command -v claude &>/dev/null && _doc_ok "claude CLI" || _doc_warn "claude CLI (needed for MCP registration)"
  echo ""

  # ── Data directories ──
  echo "Data directories:"
  for dir in projects roles history running status messages; do
    [[ -d "$POKEGENTS_DATA/$dir" ]] && _doc_ok "$POKEGENTS_DATA/$dir" || _doc_fail "$POKEGENTS_DATA/$dir missing"
  done
  echo ""

  # ── Projects / Roles ──
  echo "Projects / roles:"
  local project_count=0 role_count=0
  for f in "$POKEGENTS_DATA/projects"/*.json(N); do ((project_count++)); done
  for f in "$POKEGENTS_DATA/roles"/*.json(N); do ((role_count++)); done
  if [[ "$project_count" -gt 0 ]]; then
    _doc_ok "$project_count project(s) found"
  else
    _doc_fail "No projects in $POKEGENTS_DATA/projects/"
  fi
  if [[ "$role_count" -gt 0 ]]; then
    _doc_ok "$role_count role(s) found"
  else
    _doc_warn "No roles in $POKEGENTS_DATA/roles/"
  fi
  echo ""

  # ── Hooks ──
  echo "Hooks:"
  local settings="$HOME/.claude/settings.json"
  if [[ -f "$settings" ]]; then
    local hook_cmd="$POKEGENTS_ROOT/hooks/status-update.sh"
    local hook_count=$(jq --arg h "$hook_cmd" '[.hooks // {} | to_entries[] | select(.value | tostring | contains($h))] | length' "$settings" 2>/dev/null || echo "0")
    if [[ "$hook_count" -gt 0 ]]; then
      _doc_ok "$hook_count event(s) registered in settings.json"
    else
      _doc_fail "No pokegent hooks in settings.json — run install.sh"
    fi
    if [[ -f "$hook_cmd" && -x "$hook_cmd" ]]; then
      _doc_ok "status-update.sh is executable"
    else
      _doc_fail "status-update.sh missing or not executable"
    fi
    if bash -n "$hook_cmd" 2>/dev/null; then
      _doc_ok "status-update.sh passes syntax check"
    else
      _doc_fail "status-update.sh has syntax errors!"
    fi
  else
    _doc_fail "settings.json not found"
  fi
  echo ""

  # ── MCP ──
  echo "MCP messaging:"
  if command -v claude &>/dev/null; then
    if claude mcp list 2>/dev/null | grep -q "pokegents-messaging"; then
      _doc_ok "pokegents-messaging registered"
    else
      _doc_fail "pokegents-messaging not registered — run: claude mcp add -s user pokegents-messaging -- node \"$POKEGENTS_ROOT/mcp/server.js\""
    fi
  else
    _doc_warn "claude CLI not available, cannot check MCP"
  fi
  if [[ -f "$POKEGENTS_ROOT/mcp/node_modules/@modelcontextprotocol/sdk/server/mcp.js" ]]; then
    _doc_ok "MCP SDK installed"
  else
    _doc_fail "MCP SDK not installed — run: cd $POKEGENTS_ROOT/mcp && npm ci"
  fi
  echo ""

  # ── Dashboard ──
  echo "Dashboard:"
  if [[ -f "$POKEGENTS_ROOT/dashboard/pokegents-dashboard" ]]; then
    _doc_ok "Dashboard binary exists"
  else
    _doc_warn "Dashboard not built — run: cd $POKEGENTS_ROOT/dashboard && make build"
  fi
  local port="${POKEGENTS_PORT:-7834}"
  if lsof -ti :"$port" &>/dev/null; then
    _doc_ok "Dashboard running on port $port"
  else
    _doc_warn "Dashboard not running — start with: pokegent dashboard start"
  fi
  echo ""

  # ── Summary ──
  echo "Summary: $ok passed, $warn warnings, $fail failures"
  [[ $fail -eq 0 ]] && echo "Installation looks healthy!" || echo "Run install.sh to fix failures."
}
