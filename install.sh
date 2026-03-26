#!/usr/bin/env bash
# ccd installer — sets up data dirs, hooks, profiles, and shell integration
set -euo pipefail

CCD_ROOT="$(cd "$(dirname "$0")" && pwd)"
CCD_DATA="${CCD_DATA:-$HOME/.ccsession}"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

echo "Installing ccd from $CCD_ROOT"
echo "Data directory: $CCD_DATA"
echo ""

# ── Dependency check ────────────────────────────────────────────────────
_check_dep() {
  local name="$1" required="$2" hint="$3"
  if command -v "$name" &>/dev/null; then
    return 0
  fi
  if [[ "$required" == "true" ]]; then
    echo "✗ Missing required dependency: $name"
    echo "  $hint"
    return 1
  else
    echo "· Optional dependency missing: $name ($hint)"
    return 1
  fi
}

MISSING_REQUIRED=false
_check_dep jq true "brew install jq" || MISSING_REQUIRED=true
_check_dep curl true "brew install curl" || true
_check_dep python3 true "brew install python3" || MISSING_REQUIRED=true

HAS_NODE=true
HAS_GO=true
HAS_CLAUDE=true
_check_dep node false "brew install node — needed for MCP messaging server" || HAS_NODE=false
_check_dep npm false "comes with node — needed for MCP messaging server" || HAS_NODE=false
_check_dep go false "brew install go — needed for dashboard server" || HAS_GO=false
_check_dep claude false "see https://docs.anthropic.com/en/docs/claude-code — needed for MCP registration" || HAS_CLAUDE=false

if [[ "$MISSING_REQUIRED" == "true" ]]; then
  echo ""
  echo "Install the required dependencies above and re-run."
  exit 1
fi
echo "✓ Dependencies checked"
echo ""

# ── 1. Create data directories ──────────────────────────────────────────
mkdir -p "$CCD_DATA"/{profiles,history,running,status,messages}
echo "✓ Data directories ready"

# ── 2. Copy default config (if not present) ──────────────────────────────
if [ ! -f "$CCD_DATA/config.json" ]; then
  cp "$CCD_ROOT/defaults/config.json" "$CCD_DATA/config.json"
  echo "✓ Default config installed at $CCD_DATA/config.json"
  echo "  Edit to customize: port, default_profile, skip_permissions"
else
  echo "· Config already exists, skipping"
fi

CCD_PORT=$(jq -r '.port // 7834' "$CCD_DATA/config.json" 2>/dev/null || echo "7834")

# ── Copy default profiles (only if profiles dir is empty) ─────────────
if [ -z "$(ls -A "$CCD_DATA/profiles" 2>/dev/null)" ]; then
  cp "$CCD_ROOT"/defaults/profiles/personal.json "$CCD_DATA/profiles/"
  echo "✓ Default personal profile installed"
  echo "  Create more profiles: ccd edit <name>"
  echo "  See example: $CCD_ROOT/defaults/profiles/example-project.json"
else
  echo "· Profiles already exist, skipping defaults"
fi

# ── 3. Make hooks executable ─────────────────────────────────────────────
chmod +x "$CCD_ROOT"/hooks/*.sh
echo "✓ Hooks marked executable"

# ── 4. Set up Claude Code hooks (MERGE, not replace) ────────────────────
HOOK_CMD="$CCD_ROOT/hooks/status-update.sh"
STATUSLINE_CMD="$CCD_ROOT/hooks/statusline.sh"

if [ ! -f "$CLAUDE_SETTINGS" ]; then
  mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
  echo '{}' > "$CLAUDE_SETTINGS"
fi

# Backup before modifying
cp "$CLAUDE_SETTINGS" "${CLAUDE_SETTINGS}.bak"

# Merge hooks: for each event, append our hook entry if not already present
# This preserves any existing user hooks on the same events
jq --arg hook "$HOOK_CMD" --arg sl "$STATUSLINE_CMD" '
  # Our hook entry template
  def ccd_entry(m): {"matcher": m, "hooks": [{"type": "command", "command": $hook, "timeout": 5}]};

  # Events we need, with their matchers
  {
    "UserPromptSubmit": ccd_entry(""),
    "PreToolUse": ccd_entry(""),
    "PostToolUse": ccd_entry(""),
    "PostToolUseFailure": ccd_entry(""),
    "Stop": ccd_entry(""),
    "StopFailure": ccd_entry(""),
    "PermissionRequest": ccd_entry(""),
    "Notification": ccd_entry("idle_prompt"),
    "SessionStart": ccd_entry(""),
    "SessionEnd": ccd_entry("")
  } as $wanted |

  # Ensure .hooks exists
  .hooks //= {} |

  # For each wanted event, merge into existing hooks
  reduce ($wanted | keys[]) as $event (
    .;
    if (.hooks[$event] | type) == "array" then
      # Event exists — append our entry if our hook command is not already there
      if (.hooks[$event] | any(.hooks[]?.command == $hook)) then
        .  # Already registered, skip
      else
        .hooks[$event] += [$wanted[$event]]
      end
    else
      # Event does not exist — create it
      .hooks[$event] = [$wanted[$event]]
    end
  ) |

  # Set statusLine
  .statusLine = {"type": "command", "command": $sl}
' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp" \
  && mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"

echo "✓ Claude Code hooks configured (merged with existing)"

# ── 5. Install MCP messaging server ─────────────────────────────────────
if [ -d "$CCD_ROOT/mcp" ] && [[ "$HAS_NODE" == "true" ]]; then
  echo ""
  echo "Installing MCP messaging server..."
  (cd "$CCD_ROOT/mcp" && npm ci --silent)

  if [[ "$HAS_CLAUDE" == "true" ]]; then
    if claude mcp add -s user ccd-messaging -- node "$CCD_ROOT/mcp/server.js" 2>/dev/null; then
      echo "✓ MCP messaging server registered"
    else
      echo "· MCP registration failed. Register manually:"
      echo "  claude mcp add -s user ccd-messaging -- node \"$CCD_ROOT/mcp/server.js\""
    fi
  else
    echo "· claude CLI not found. Register MCP manually when available:"
    echo "  claude mcp add -s user ccd-messaging -- node \"$CCD_ROOT/mcp/server.js\""
  fi
else
  echo "· Skipping MCP server (requires node + npm)"
fi

# ── 6. Build dashboard (optional) ───────────────────────────────────────
if [ -d "$CCD_ROOT/dashboard" ]; then
  if [[ "$HAS_GO" == "true" && "$HAS_NODE" == "true" ]]; then
    echo ""
    echo "Building dashboard..."
    (cd "$CCD_ROOT/dashboard" && CGO_CFLAGS="-DSQLITE_ENABLE_FTS5" go build -o ccd-dashboard . 2>&1) \
      && echo "✓ Go server built" \
      || echo "✗ Go server build failed"
    (cd "$CCD_ROOT/dashboard/web" && npm ci --silent && npm run build 2>&1 | tail -1) \
      && echo "✓ Frontend built" \
      || echo "✗ Frontend build failed"

    echo "  Start dashboard: ccd dashboard start"
    echo "  Open: http://localhost:$CCD_PORT"
  else
    local_missing=""
    [[ "$HAS_GO" == "false" ]] && local_missing="go"
    [[ "$HAS_NODE" == "false" ]] && local_missing="${local_missing:+$local_missing, }node/npm"
    echo ""
    echo "· Skipping dashboard build (missing: $local_missing)"
    echo "  Install dependencies, then run: cd dashboard && make build"
  fi
fi

# ── 7. Update .zshrc ────────────────────────────────────────────────────
ZSHRC="$HOME/.zshrc"
SOURCE_LINE="source \"$CCD_ROOT/ccd.sh\""

if grep -qF 'ccd.sh' "$ZSHRC" 2>/dev/null; then
  echo "· ccd already sourced in .zshrc"
elif grep -qF 'ccd()' "$ZSHRC" 2>/dev/null; then
  echo ""
  echo "⚠ Found inline ccd() function in .zshrc."
  echo "  Remove it manually, then add:  $SOURCE_LINE"
else
  echo "" >> "$ZSHRC"
  echo "# ccd — Claude Code session manager" >> "$ZSHRC"
  echo "$SOURCE_LINE" >> "$ZSHRC"
  echo "✓ Added source line to .zshrc"
fi

echo ""
echo "Done! Restart your shell or run:  source ~/.zshrc"
echo ""
echo "Quick start:"
echo "  ccd                   # launch personal profile"
echo "  ccd ls                # list profiles"
echo "  ccd edit my-project   # create a new profile"
echo "  ccd my-project        # launch it"
echo "  ccd doctor            # verify installation"
