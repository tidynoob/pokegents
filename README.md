# pokegents — Local Agent Orchestration Platform

Run multiple Claude Code/Codex agents simultaneously with project + role configs, session tracking, real-time notifications, agent-to-agent messaging, and a local web dashboard to monitor them all.

![Pokegents Dashboard](docs/screenshot.png)

## What it does

- **Projects + roles** — Projects define working directories/context; roles define agent behavior
- **Session tracking** — See all active agents, their status (idle/busy/done/needs input), and what they're working on
- **Dashboard** — Web UI showing all agents with live status updates, thinking traces, and session search
- **Notifications** — macOS alerts when an agent finishes or needs your input
- **Session search** — Full-text search across all past conversations (not just titles)
- **Tab management** — Click an agent in the dashboard to jump to its iTerm2 tab

## Install

Source checkout install:

```bash
git clone https://github.com/<your-org>/pokegents.git ~/Projects/pokegents
cd ~/Projects/pokegents
./install.sh
~/.local/bin/pokegents
```

Release artifact install is the same flow after extracting the archive:

```bash
cd pokegents
./install.sh
~/.local/bin/pokegents
```

Development source build:

```bash
git clone https://github.com/<your-org>/pokegents.git ~/Projects/pokegents
cd ~/Projects/pokegents
POKEGENTS_DEV_BUILD=1 ./install.sh
~/.local/bin/pokegents
```

The installer does **not** edit `.zshrc` and does **not** require `source ~/.zshrc`. It installs standalone shims:

- `~/.local/bin/pokegents`
- `~/.local/bin/pokegent` compatibility alias

**Requirements:** macOS or Linux, python3, and at least one authenticated agent CLI/provider (Claude Code CLI for Claude-backed agents, Codex for Codex-backed agents).

**Developer/source build requirements:** Go 1.21+, Node.js 18+, npm. Release artifacts should already include built dashboard assets.

**Optional:** iTerm2. Dashboard/chat mode is the default; iTerm2 enables tab colors, tab focus, and terminal-backed sessions.

**Dashboard:** Pokegents runs as a local web app. Start/open it with `pokegents` or `pokegent dashboard open`. The browser/editor open commands are configurable in Settings → Agent Config.

The installer will:
1. Create `~/.pokegents/` data directories
2. Install default config and backend preferences
3. Install default roles (`implementer`, `reviewer`, `researcher`, `pm`)
4. Create a default `current` project from the install cwd
5. Install CLI shims
6. Tell you how to open the dashboard

The installer intentionally does not edit shell rc files, Claude settings, or MCP config. First-run onboarding and Settings → Dev/Repair handle Claude hooks and MCP messaging with backups.

Verify your installation: `pokegents doctor`

## Usage

### Launching sessions

```bash
pokegent                         # Launch default project
pokegent my-project              # Launch a project
pokegent dev@my-project          # Launch with a role + project
pokegent @my-project             # Project only (no role)
pokegent dev@                    # Role only (uses default project)
pokegent my-project -r           # Resume a session (interactive picker)
pokegent my-project -r abc123    # Resume a specific session by ID prefix
pokegent my-project -w feature   # Launch in a git worktree
pokegent ls                      # List projects and roles
```

### Managing projects and roles

```bash
pokegent edit project my-project
pokegent edit role reviewer
```

Project schema:

```json
{
  "title": "My Project",
  "emoji": "📦",
  "color": [100, 180, 255],
  "iterm2_profile": "",
  "cwd": "~/Projects/my-project",
  "add_dirs": [],
  "context_prompt": "You are working on my-project."
}
```

| Field | Description |
|-------|-------------|
| `title` | Display name shown in tab and dashboard |
| `emoji` | Shown in tab title and dashboard |
| `color` | RGB array `[r, g, b]` for terminal tab color and dashboard tinting |
| `iterm2_profile` | iTerm2 Dynamic Profile name (optional, overrides color) |
| `cwd` | Working directory for this project |
| `add_dirs` | Extra directories to pass to Claude via `--add-dir` |
| `context_prompt` | Appended as project-specific context for this project |

Roles live in `~/.pokegents/roles/*.json` and add role-specific prompts/model settings.


### Sprite assets

Pokegents does not commit Pokémon sprite PNGs to this repository. Source builds fetch them from [`msikma/pokesprite`](https://github.com/msikma/pokesprite):

```bash
./scripts/fetch-pokesprite-assets.sh
```

`dashboard/web/public/town.png` is kept in-repo; runtime sprite PNGs under `dashboard/web/public/sprites/` are generated/downloaded and ignored by git. Release artifacts may include generated sprites for offline use. PokeSprite's README states that the sprite images are © Nintendo/Creatures Inc./GAME FREAK Inc., while its code/metadata are MIT-licensed. Pokegents is an unofficial, personal-use tool and is not affiliated with, endorsed by, or sponsored by Nintendo, Creatures Inc., GAME FREAK Inc., The Pokémon Company, or the PokeSprite project. Pokémon and related names/marks belong to their respective owners.

### Dashboard

```bash
pokegents                     # Open dashboard using the configured browser command
pokegent dashboard           # Open the browser dashboard
pokegent dashboard start     # Start the dashboard server (background)
pokegent dashboard stop      # Stop the dashboard server
pokegent dashboard build     # Build server + frontend, restart (no session restart)
pokegent dashboard restart   # Restart server without rebuilding
```

The dashboard shows:
- **Configurable grid** — set rows and columns in settings, cards snap to grid positions
- **Drag and drop** cards to reorder — other cards smoothly animate out of the way (iOS-style)
- **Resize cards** by dragging the bottom-right handle — snaps to grid cells
- **Status**: idle (grey/dimmed), busy (yellow), done (green), needs input (red)
- **Your last prompt** to each agent for context
- **Live thinking traces** while agents are busy
- **Full responses** when agents finish (with markdown formatting, scrollable)
- **Pixel creature icon** unique to each session (deterministic from session ID)
- **Context health bar** (green/yellow/red) showing token usage per agent
- **Click** an agent to open/select its chat panel, or focus its iTerm2 tab for terminal-backed agents
- **Double-click** the name to rename an agent
- **Collapse** agents to pokeballs — click to expand with throw animation
- **Pokeball animations** — collapse plays a recall beam, expand throws the ball with bounce + flash
- **Hover pokeballs** to preview collapsed agent status
- **Paste images** (Cmd+V) into agent input boxes — uploads to Claude's image cache
- **Spawn new agents** from the "NEW AGENT" button
- **PC Box** (`/` or PC BOX button) — GBA-style grid browser for past sessions with sprite icons, last prompt/message preview
- **Resume** past sessions directly from the PC Box
- **Grid layout persistence** — card positions saved to server, survive refresh
- **Layout presets** — save/load named grid layouts via API
- **Idle dimming** — agents idle for 10+ minutes fade to 60% opacity
- **Message delivery animations** — sender sprite flies to recipient
- **Configurable sprite animations** — busy (hop/shake/wiggle), idle (blink/doze), done (sway)
- **Floating emoji bubbles** — work emojis when busy, celebration emoji on completion


### Security model

The dashboard server is local-first. By default it binds to `127.0.0.1:{port}` and rejects non-local browser origins for mutating requests. Override the bind host only for trusted networks:

```bash
pokegents-dashboard serve --bind 127.0.0.1
POKEGENTS_BIND_HOST=127.0.0.1 pokegent dashboard start
```

Do not expose the dashboard port to the public internet; endpoints can launch agents, edit local config, and read local session metadata.


### Multiple concurrent agents

pokegent handles running multiple agents on the same project. When you launch a second session of the same project, it prompts you to name both sessions to tell them apart:

```
⚠  Project 'client' is already running in 1 other session(s):
   • 📦 Client SDK  (tty: /dev/ttys001)

Rename existing session "Client SDK" to (enter to skip): reviewer
Name for this new session (enter for "Client SDK"): test-writer
```

## Architecture

```
~/.pokegents/                    # User data (per-machine)
├── projects/*.json              # Project configs
├── roles/*.json                 # Role configs
├── running/*.json               # Active session registry
├── status/*.json                # Live status from hooks
└── history/*.json               # Recent sessions per project

~/Projects/pokegents/                  # Code (shared via git)
├── pokegent.sh                  # CLI implementation
├── install.sh                   # Installer
├── hooks/
│   ├── status-update.sh         # Writes status on every Claude event
│   └── statusline.sh            # Renders agent info in Claude's status bar
├── defaults/
│   ├── config.json              # Default config template
│   ├── projects/                # Project templates
│   └── roles/                   # Role templates
├── mcp/
│   └── server.js               # MCP messaging server (agent-to-agent comms)
└── dashboard/                   # Web dashboard (Go + React)
    ├── server/                  # Go backend (SSE, REST, search, notifications)
    ├── web/                     # React frontend (Vite + Tailwind)
    └── hooks/
        └── dashboard-notify.sh  # Forwards events to dashboard via HTTP
```

### How status tracking works

Claude Code [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) fire on lifecycle events. The `status-update.sh` hook writes a JSON status file on each event:

| Event | Dashboard State |
|-------|----------------|
| `SessionStart` | idle (grey) |
| `UserPromptSubmit` | busy (yellow) |
| `PreToolUse` / `PostToolUse` | busy (yellow) + tool detail |
| `Stop` | done (green) |
| `PermissionRequest` | needs input (red) |
| `Notification(idle_prompt)` | done (green) — only if agent was busy |
| `SessionEnd` | removed from dashboard |

The dashboard server watches these files via fsnotify and also receives events via HTTP from `dashboard-notify.sh` for lower latency. Updates are pushed to the frontend via Server-Sent Events (SSE).

### Agent-to-agent messaging

When running multiple agents, they can communicate via MCP tools:

```
Agent A: "Send the test results to the reviewer"
→ Agent A calls send_message(to="reviewer_id", content="Tests pass...")
→ Reviewer agent gets nudged and reads the message
→ Reviewer replies with feedback
```

Each agent's system prompt includes its session ID and messaging instructions. Messages are delivered via:
1. **Hook notification** — on the next `UserPromptSubmit`, agents see "You have N pending messages"
2. **Auto-nudge** — idle agents get "check messages" typed into their terminal after a 2s delay (with debouncing)

## Configuration

### Config file (`~/.pokegents/config.json`)

```json
{
  "port": 7834,
  "dashboard_open_mode": "browser",
  "default_interface": "chat",
  "default_backend": "claude",
  "default_project": "current",
  "default_role": "implementer",
  "skip_permissions": true,
  "iterm2_restore_profile": "Default",
  "editor_open_command": "code {path}",
  "browser_open_command": "open -a \"Google Chrome\" {url}"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `7834` | Dashboard server port |
| `dashboard_open_mode` | `"browser"` | Dashboard launch mode |
| `default_interface` | `"chat"` | New-agent interface: `chat` or `iterm2` |
| `default_backend` | `"claude"` | Provider backend used by default |
| `default_project` | `"current"` | Project launched by bare `pokegent` command |
| `default_role` | `"implementer"` | Optional role for bare `pokegent` command |
| `skip_permissions` | `true` | Global default for `--dangerously-skip-permissions` where supported |
| `iterm2_restore_profile` | `"Default"` | iTerm2 profile restored on session exit |
| `editor_open_command` | `"code {path}"` | Command used to open local files/configs from the UI |
| `browser_open_command` | `"open -a \"Google Chrome\" {url}"` | Command used to open dashboard/external URLs |

Open commands support `{path}`, `{file}`, `{url}`, and `{target}` placeholders. If no placeholder is present, the target is appended. Per-role or per-project `skip_permissions`, `model`, and `effort` can override global/default backend choices where supported.

### Backend/model config (`~/.pokegents/backends.json`)

Backends are provider runtimes; concrete models are configured under each provider. For example:

```json
{
  "version": 2,
  "backends": {
    "claude": {
      "name": "Claude",
      "type": "claude-acp",
      "default": true,
      "default_model": "sonnet",
      "models": {
        "sonnet": { "name": "Sonnet", "model": "sonnet" },
        "opus": { "name": "Opus", "model": "opus" },
        "haiku": { "name": "Haiku", "model": "haiku" }
      }
    },
    "codex": {
      "name": "Codex",
      "type": "codex-acp",
      "default_model": "default",
      "models": {
        "default": { "name": "Provider default", "model": "" }
      },
      "env": {}
    }
  }
}
```

Use Settings → Agent Config to open/edit config files. Keep secrets in local config only; do not commit `~/.pokegents/backends.json`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POKEGENTS_DATA` | `~/.pokegents` | Data directory path |
| `POKEGENTS_DASHBOARD_URL` | `http://localhost:{port}` | Dashboard URL (auto-set from config) |

### Adding to an existing Claude Code setup

If you already have hooks in `~/.claude/settings.json`, use dashboard onboarding or Settings → Dev/Repair to install/repair pokegents hooks. The repair flow creates backups and merges pokegents hooks alongside existing hooks; the installer itself does not modify Claude settings.

## Platform support

| Feature | macOS + iTerm2 | macOS + other terminal | Linux |
|---------|---------------|----------------------|-------|
| Session management | Full | Full | Full |
| Status tracking | Full | Full | Full |
| Dashboard | Full | Full | Full |
| Agent messaging | Full | Full | Full |
| Tab colors | Yes | No | No |
| Click-to-focus tab | Yes | No | No |
| Auto-nudge (typing into terminal) | Yes | No | No |
| Session cloning | Yes | No | No |

Core functionality (projects, roles, session tracking, dashboard, messaging) works everywhere. Terminal integration features (tab colors, focus, nudging) require iTerm2 on macOS.

## Updating

Pull the latest changes and re-run the installer:

```bash
cd ~/Projects/pokegents    # or wherever you cloned it
git pull
./install.sh         # refreshes shims/config defaults; set POKEGENTS_DEV_BUILD=1 to rebuild from source
```

The installer is idempotent — it won't overwrite your projects, roles, config, shell rc files, Claude settings, or MCP config. It refreshes CLI shims and can rebuild binaries/assets when `POKEGENTS_DEV_BUILD=1` is set.

If you're running agents when you update, use `pokegent reload` to restart everything cleanly:

```bash
pokegent reload           # saves all running sessions, rebuilds, relaunches
```

## Full command reference

```bash
# Sessions
pokegent                         # Launch default project/role
pokegent <project>               # Launch a project
pokegent <role>@<project>        # Launch a role in a project
pokegent @<project>              # Launch a project with no role
pokegent <role>@                 # Launch a role in the default project
pokegent <project> -r            # Resume (Claude's session picker)
pokegent <project> -r <id>       # Resume specific session by ID prefix
pokegent <project> -w <name>     # Launch in a git worktree

# Project/role management
pokegent ls                      # List projects and roles
pokegent projects                # List projects
pokegent roles                   # List roles
pokegent edit project <name>     # Create or edit a project in $EDITOR
pokegent edit role <name>        # Create or edit a role in $EDITOR

# Dashboard
pokegents                        # Open dashboard using configured browser command
pokegent dashboard               # Open the browser dashboard
pokegent dashboard start         # Start dashboard server (background)
pokegent dashboard stop          # Stop dashboard server
pokegent dashboard build         # Build server + frontend, restart dashboard
pokegent dashboard restart       # Restart server (no rebuild)

# Operations
pokegent reload                  # Stop all sessions, rebuild, relaunch everything
pokegent doctor                  # Verify installation (deps, config, optional hooks/MCP)
```

## Activity log

When multiple agents work on the same project, they automatically share an activity log. On each turn:

1. **On finish** — the agent's changed files and summary are appended to `~/.pokegents/activity/`
2. **On next prompt** — agents see what others changed since their last turn, with file overlap warnings

This prevents agents from silently overwriting each other's work. The dashboard shows the activity feed in a collapsible bottom bar alongside the message log.

## Image support

Paste screenshots or images (Cmd+V) directly into any agent's input box in the dashboard. The image is saved to `~/.claude/image-cache/{session_id}/` and the file path is inserted into the prompt. When you send it, the agent reads the image via its Read tool. Include a prompt like "describe this image" or "look at this screenshot" alongside the path.

## Built-in defaults

pokegents ships with default roles in `defaults/roles/` and a starter project in `defaults/projects/`.

Default roles include `implementer`, `reviewer`, `researcher`, and `pm`.

## Troubleshooting

**Agent doesn't show in dashboard**: Check that `~/.pokegents/running/` has a file for the session. Sessions started before installing pokegents won't have running files.

**Status stuck on wrong state**: The status file may be stale. Delete it: `rm ~/.pokegents/status/<session-id>.json` — it will be recreated on the next hook event.

**Dashboard says "offline"**: Make sure the server is running: `pokegent dashboard start`. Check logs: `cat /tmp/pokegents-dashboard.log`.

**Search returns no results**: The search index builds on startup and updates every 5 minutes. Force a rebuild: `cd dashboard && ./pokegents-dashboard index`.

**Messages not delivered**: Agents receive message notifications on their next prompt. If an agent is idle, the auto-nudge types "check messages" after 2 seconds (iTerm2 only). Check `pokegent doctor` to verify MCP registration.

**`pokegents` command not found after install**: Run `~/.local/bin/pokegents` directly or add `~/.local/bin` to your PATH. The installer no longer edits `.zshrc`.

**Dashboard build fails**: Ensure Go 1.21+ and Node.js 18+ are installed. Run `pokegent doctor` to check. Build manually: `cd dashboard && make build`.

**Hook errors blocking Claude**: If you see hook errors on every prompt, the hook script may have a syntax error. Run `bash -n hooks/status-update.sh` to check. As a last resort, remove pokegent hooks from `~/.claude/settings.json` and re-run `./install.sh`.

**Wrong agent name in resume page**: Rename the agent in the dashboard (double-click the name). This updates both the dashboard and Claude's session title. Old sessions from before the rename may still show the original name.
