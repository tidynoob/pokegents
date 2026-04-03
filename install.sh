#!/usr/bin/env bash
# pokegents installer — sets up data dirs, hooks, profiles, and shell integration
set -euo pipefail

POKEGENTS_ROOT="$(cd "$(dirname "$0")" && pwd)"
POKEGENTS_DATA="${POKEGENTS_DATA:-$HOME/.pokegents}"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

echo "Installing pokegents from $POKEGENTS_ROOT"
echo "Data directory: $POKEGENTS_DATA"
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
mkdir -p "$POKEGENTS_DATA"/{profiles,projects,roles,history,running,status,messages}
echo "✓ Data directories ready"

# ── 2. Copy default config (if not present) ──────────────────────────────
if [ ! -f "$POKEGENTS_DATA/config.json" ]; then
  cp "$POKEGENTS_ROOT/defaults/config.json" "$POKEGENTS_DATA/config.json"
  echo "✓ Default config installed at $POKEGENTS_DATA/config.json"
  echo "  Edit to customize: port, default_profile, skip_permissions"
else
  echo "· Config already exists, skipping"
fi

POKEGENTS_PORT=$(jq -r '.port // 7834' "$POKEGENTS_DATA/config.json" 2>/dev/null || echo "7834")

# ── Copy default profiles (only if profiles dir is empty) ─────────────
if [ -z "$(ls -A "$POKEGENTS_DATA/profiles" 2>/dev/null)" ]; then
  cp "$POKEGENTS_ROOT"/defaults/profiles/personal.json "$POKEGENTS_DATA/profiles/"
  echo "✓ Default personal profile installed"
else
  echo "· Profiles already exist, skipping defaults"
fi

# ── Copy default projects and roles (only missing files) ─────────────
_installed_projects=0
for f in "$POKEGENTS_ROOT"/defaults/projects/*.json; do
  [ -f "$f" ] || continue
  target="$POKEGENTS_DATA/projects/$(basename "$f")"
  if [ ! -f "$target" ]; then
    cp "$f" "$target"
    _installed_projects=$((_installed_projects + 1))
  fi
done
[ $_installed_projects -gt 0 ] && echo "✓ Installed $_installed_projects default project(s)" || echo "· Projects already exist, skipping defaults"

_installed_roles=0
for f in "$POKEGENTS_ROOT"/defaults/roles/*.json; do
  [ -f "$f" ] || continue
  target="$POKEGENTS_DATA/roles/$(basename "$f")"
  if [ ! -f "$target" ]; then
    cp "$f" "$target"
    _installed_roles=$((_installed_roles + 1))
  fi
done
[ $_installed_roles -gt 0 ] && echo "✓ Installed $_installed_roles default role(s)" || echo "· Roles already exist, skipping defaults"
echo "  Compose with: pokegent dev@personal, pokegent pm@<project>"

# ── 3. Make hooks executable ─────────────────────────────────────────────
chmod +x "$POKEGENTS_ROOT"/hooks/*.sh
echo "✓ Hooks marked executable"

# ── 4. Set up Claude Code hooks (MERGE, not replace) ────────────────────
HOOK_CMD="$POKEGENTS_ROOT/hooks/status-update.sh"
STATUSLINE_CMD="$POKEGENTS_ROOT/hooks/statusline.sh"

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
if [ -d "$POKEGENTS_ROOT/mcp" ] && [[ "$HAS_NODE" == "true" ]]; then
  echo ""
  echo "Installing MCP messaging server..."
  (cd "$POKEGENTS_ROOT/mcp" && npm ci --silent)

  if [[ "$HAS_CLAUDE" == "true" ]]; then
    if claude mcp add -s user pokegents-messaging -- node "$POKEGENTS_ROOT/mcp/server.js" 2>/dev/null; then
      echo "✓ MCP messaging server registered"
    else
      echo "· MCP registration failed. Register manually:"
      echo "  claude mcp add -s user pokegents-messaging -- node \"$POKEGENTS_ROOT/mcp/server.js\""
    fi
  else
    echo "· claude CLI not found. Register MCP manually when available:"
    echo "  claude mcp add -s user pokegents-messaging -- node \"$POKEGENTS_ROOT/mcp/server.js\""
  fi
else
  echo "· Skipping MCP server (requires node + npm)"
fi

# ── 6. Build dashboard (optional) ───────────────────────────────────────
if [ -d "$POKEGENTS_ROOT/dashboard" ]; then
  if [[ "$HAS_GO" == "true" && "$HAS_NODE" == "true" ]]; then
    echo ""
    echo "Building dashboard..."
    (cd "$POKEGENTS_ROOT/dashboard" && CGO_CFLAGS="-DSQLITE_ENABLE_FTS5" go build -o pokegents-dashboard . 2>&1) \
      && echo "✓ Go server built" \
      || echo "✗ Go server build failed"
    (cd "$POKEGENTS_ROOT/dashboard/web" && npm ci --silent && npm run build 2>&1 | tail -1) \
      && echo "✓ Frontend built" \
      || echo "✗ Frontend build failed"

    echo "  Start dashboard: pokegent dashboard start"
    echo "  Open: http://localhost:$POKEGENTS_PORT"
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
SOURCE_LINE="source \"$POKEGENTS_ROOT/pokegent.sh\""

if grep -qF 'pokegent.sh' "$ZSHRC" 2>/dev/null; then
  echo "· pokegent already sourced in .zshrc"
elif grep -qF 'pokegent()' "$ZSHRC" 2>/dev/null; then
  echo ""
  echo "⚠ Found inline pokegent() function in .zshrc."
  echo "  Remove it manually, then add:  $SOURCE_LINE"
else
  echo "" >> "$ZSHRC"
  echo "# pokegents — Claude Code session manager" >> "$ZSHRC"
  echo "$SOURCE_LINE" >> "$ZSHRC"
  echo "✓ Added source line to .zshrc"
fi

echo ""
echo "Done! Restart your shell or run:  source ~/.zshrc"
echo ""
echo "Quick start:"
echo "  pokegent                   # launch personal profile"
echo "  pokegent ls                # list profiles"
echo "  pokegent edit my-project   # create a new profile"
echo "  pokegent my-project        # launch it"
echo "  pokegent doctor            # verify installation"
