# Pokegents — Requirements & Architecture

A pokegent is a wrapper around a Claude Code session that supports starting from a profile, cross-agent communication, cloning, session lifecycle management, and a real-time dashboard for multi-agent monitoring and orchestration.

The **Pokegents Dashboard** is a web UI to monitor, manage, and coordinate multiple pokegents in real time.

---

## 1. Profile System

A profile defines the configuration for launching a pokegent. Profiles are JSON files stored in `~/.pokegents/profiles/`.

### Requirements

1. User can start a pokegent with a named profile that provides:
   - **Agent setup**: working directory, system prompt, extra context directories, permission settings
   - **UI rendering**: display name, emoji, RGB color
   - **Terminal theming**: iTerm2 profile name (optional)
2. User can create, edit, and list profiles via CLI (`pokegent edit <name>`, `pokegent ls`)
3. A default profile ("personal") is installed on first setup
4. Example profile templates are shipped for common patterns (project work, code review)
5. Each profile field has sensible defaults — only `cwd` is required

### Profile Schema

```json
{
  "title": "My Project",
  "emoji": "📦",
  "color": [100, 180, 255],
  "cwd": "~/Projects/my-project",
  "add_dirs": [],
  "system_prompt": "You are working on my-project.",
  "iterm2_profile": "",
  "skip_permissions": false
}
```

---

## 2. Session Lifecycle

A session is a running pokegent instance. Multiple sessions can run concurrently, even from the same profile.

### Requirements

1. **Launch**: `pokegent <profile>` starts Claude Code with the profile's config, registers a running file, sets terminal theming
2. **Resume**: `pokegent <profile> -r [id]` resumes a previous session. Supports interactive picker (bare `-r`) or prefix match (`-r abc123`)
3. **Clone/Fork**: `pokegent <profile> --resume <id> --fork-session` creates a new session forked from an existing one, preserving conversation history
4. **Duplicate handling**: When multiple sessions share a profile, new sessions are auto-named "(clone)". Dashboard rename persists across resume
5. **Cleanup on exit**: Running file removed, history saved, terminal profile restored, iTerm2 dynamic profile cleaned up
6. **Stale detection**: On launch, dead sessions are detected and cleaned via 3-tier liveness check:
   - Claude process PID alive?
   - Shell PID alive?
   - Claude session registry has a live process for this TTY?
7. **Reload**: `pokegent reload` snapshots all running sessions, stops them, rebuilds the dashboard, and relaunches everything

### Session Identity

Each session has multiple IDs (this is a critical architectural detail):

| ID | Set by | Stable? | Unique for clones? | Purpose |
|----|--------|---------|-------------------|---------|
| `ccd_session_id` | pokegent.sh (UUID) | Yes | Yes | Mailbox routing, env var `POKEGENTS_SESSION_ID` |
| `session_id` | Claude (conversation ID) | No (patched by hook) | No (clones share during resume) | Status files, transcript lookup |
| `iterm_session_id` | iTerm2 | Yes | Yes | Terminal tab matching |

### Data Files

- `~/.pokegents/running/{profile}-{session_id}.json` — Active session registry
- `~/.pokegents/status/{session_id}.json` — Live state from hooks
- `~/.pokegents/history/{profile}.json` — Last 5 sessions per profile

---

## 3. Hook System

Claude Code hooks fire on lifecycle events. The `status-update.sh` hook processes all events and writes structured state.

### Requirements

1. **State tracking**: Maintain a state machine per session: `idle → busy → done → needs_input → error`
2. **Crash resilience**: Hooks must NEVER crash. No `set -e`. Every external command has fallback handling. A crashing hook blocks ALL Claude operations.
3. **Running file reconciliation**: On every event (not just SessionStart), verify the running file exists for this session. If missing, find it by `ccd_session_id` and patch it. This handles `--fork-session` where SessionStart may not fire.
4. **Clone safety**: Running file matching must ONLY use `ccd_session_id` field (Pass 1). Matching by `session_id` (Pass 2) or TTY (Pass 3) only when no `POKEGENTS_SESSION_ID` is set (legacy fallback). Collision guard: never rename if target file exists.
5. **Activity logging**: On Stop, append changed files + summary to the activity log. On UserPromptSubmit, inject recent changes from other agents via systemMessage.
6. **Message delivery**: On UserPromptSubmit, check for pending messages and inject via systemMessage. Combined with activity log in a single notification.
7. **Message budget**: Reset per-agent message count on each UserPromptSubmit.
8. **Compaction detection**: When detail is "compacting" and Stop fires with empty summary, set summary to "Compacted".

### State Machine Transitions

| Transition | Trigger | Guard |
|-----------|---------|-------|
| `* → busy` | UserPromptSubmit | Always |
| `* → busy` | PreToolUse, PostToolUse | Only if currently busy (no overwrite of done/idle) |
| `busy → done` | Stop | Always |
| `busy → done` | Notification(idle_prompt) | Only if current state is busy |
| `* → needs_input` | PermissionRequest | Always |
| `* → error` | StopFailure | Always |
| `* → idle` | SessionStart | Unless current state is busy (clone protection) |

---

## 4. Messaging System

Agents communicate via MCP tools registered as `pokegents-messaging`.

### Requirements

1. **List agents**: Show all active pokegents with name, status, session ID prefix, and last task summary
2. **Send message**: Route message from one agent to another by session ID prefix. Resolve against both `session_id` and `ccd_session_id` for clone safety
3. **Check messages**: Read and consume pending messages from own mailbox. Auto-detect own session ID from `POKEGENTS_SESSION_ID` environment variable
4. **Message budget**: 5 messages per turn (configurable). Resets on each UserPromptSubmit. Prevents agents from spamming each other in loops
5. **Delivery pipeline**:
   - Message stored as JSON file in `~/.pokegents/messages/{ccd_session_id}/`
   - Hook fires on next UserPromptSubmit → injects notification via systemMessage
   - Agent calls `check_messages` MCP tool → reads and deletes message files
6. **Auto-nudge**: When a message is sent to an idle/done agent, the server queues a nudge. After 2s delay (batching), if agent is still idle for 3+ seconds, types "check messages" into their terminal. 10s debounce per agent.
7. **Server-side resolution**: The dashboard's `/api/messages/consume/{id}` endpoint resolves both session IDs and ccd_session_ids, with fallbacks to running file scan and mailbox directory scan

### Message Schema

```json
{
  "id": "1774464684898440000",
  "from": "session-id",
  "from_name": "Agent A",
  "to": "session-id",
  "to_name": "Agent B",
  "content": "Your review feedback...",
  "timestamp": "2026-03-25T20:51:28Z",
  "delivered": false
}
```

---

## 5. Activity Log System

Agents share an append-only activity log so they know what others changed.

### Requirements

1. **On Stop**: Extract file paths from `recent_actions` in the status file. Append a 1-liner to `~/.pokegents/activity/{project_hash}.log` with timestamp, session ID, agent name, files, and summary
2. **On UserPromptSubmit**: Read new entries since this agent's last check (line-number tracking). Inject last 3 entries from OTHER agents via systemMessage
3. **File overlap detection**: If another agent recently modified files that this agent also worked on, add a warning to the systemMessage
4. **Rotation**: When log exceeds 500 lines, truncate to last 200
5. **Dashboard display**: Activity feed shown in bottom bar alongside messages, with clickable agent pills and file highlighting
6. **Per-project**: Logs are keyed by project hash (derived from CWD), not global

### Log Format

```
[2026-03-25T22:15:00Z] [session_id] [Agent Name] file1.go, file2.ts — Summary of what was done
```

---

## 6. Naming System

Agent display names are visible in the dashboard, terminal tabs, and session resume picker.

### Requirements

1. **Sources of truth**: Running file `display_name` (live agents) and JSONL transcript `custom-title` (persisted for resume)
2. **On rename** (via dashboard): Update all four locations: running file, JSONL transcript, search index, and iTerm tab title
3. **On resume**: Read `custom-title` from JSONL transcript and use as `display_name` in new running file
4. **Search enrichment**: The "Previous sessions" page overrides JSONL titles with running file display names for active sessions
5. **Clone naming**: New clones are auto-named "{title} (clone)". Users can rename via dashboard

---

## 7. Dashboard Server

Go HTTP server providing REST API, SSE real-time updates, and file watching.

### Requirements

1. **State management**: Merge running files + status files + profiles into a unified `AgentState` view. Rebuild on every file change
2. **Real-time updates**: SSE endpoint pushes state changes to all connected frontends
3. **File watcher**: Watch `running/` and `status/` directories via fsnotify. Handle Write, Create, Remove, AND Rename events
4. **Transcript poller** (2s interval):
   - Backfill context tokens and user prompts for all agents
   - Update trace for busy agents
   - Detect compaction (token count decrease on done agents)
5. **Stale cleanup** (periodic): 30s grace period for new files, then 3-tier liveness check. Remove dead agents
6. **Search**: SQLite FTS5 full-text search across all session transcripts. Background indexer updates every 5 minutes
7. **Platform abstraction**: `TerminalIntegration` interface with iTerm2 (darwin) and stub (!darwin) implementations
8. **Nudger**: Queue-based auto-nudge for idle agents receiving messages
9. **Configuration**: Read port from `~/.pokegents/config.json`, fallback to 7834

### Key API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List all active agents |
| POST | `/api/sessions/{id}/focus` | Focus agent's terminal |
| POST | `/api/sessions/{id}/rename` | Rename agent (syncs all 4 locations) |
| POST | `/api/sessions/{id}/prompt` | Type text into agent's terminal |
| POST | `/api/sessions/{id}/clone` | Fork agent session |
| POST | `/api/sessions/{id}/resume` | Resume a past session |
| POST | `/api/sessions/{id}/shutdown` | Gracefully close agent |
| GET | `/api/events` | SSE real-time state stream |
| GET | `/api/search?q=` | Full-text session search |
| GET | `/api/search/recent` | Recent sessions for resume picker |
| POST | `/api/messages` | Send inter-agent message |
| POST | `/api/messages/consume/{id}` | Read + delete messages (MCP) |
| GET | `/api/activity` | Activity log entries |

---

## 8. Dashboard Frontend

React + Vite + Tailwind web app served by the Go server.

### Requirements

1. **Adaptive layout**: 5-tier system (max → standard → standard-short → compact → compact-minimal) computed from window size and agent count. Smooth degradation as agents are added
2. **Agent cards** showing:
   - Sprite icon (Pokemon, customizable per session, bouncing animation)
   - Display name (double-click to rename)
   - Status badge with live duration timer
   - Context window health bar (token usage %)
   - Last user prompt
   - Output/trace (live while busy, final response when done)
   - Quick command input
3. **Grouping**: In max mode, agents grouped by profile with section headers. Other modes use flat grid
4. **Context menu** (right-click): Go to terminal, check messages, rename, change sprite, spawn clone, collapse
5. **Session browser**: Search past sessions, resume from results. Display names enriched from running files
6. **Message log**: Bottom bar with Messages and Activity tabs. Clickable agent pills, auto-scroll
7. **Sprite system**: ~900 Pokemon sprites loaded at runtime from URLs. Sprite overrides persisted per session. Hash-based default assignment
8. **SSE auto-reconnect**: 3s backoff on disconnect
9. **Persistence**: Collapsed cards, custom agent ordering saved to localStorage/server

---

## 9. iTerm2 Integration (macOS only)

Optional terminal integration for richer multi-agent experience. All features gracefully skip on non-iTerm2 terminals.

### Requirements

1. **Tab colors**: Set via iTerm2 escape sequences from profile RGB color
2. **Tab titles**: Set via standard escape sequences (works on most terminals)
3. **Sprite icons**: Per-session Dynamic Profile with custom icon path pointing to Pokemon sprite PNG
4. **Tab focus**: AppleScript finds session by `iterm_session_id` UUID, activates window/tab/session
5. **Text injection**: AppleScript types text into agent terminal (for auto-nudge, send prompt)
6. **Tab naming**: AppleScript sets session name (for dashboard rename sync)
7. **Clone/Resume from dashboard**: Opens new iTerm tab, waits 1s for shell init, types `pokegent <profile> -r <id>`
8. **Cleanup on exit**: Remove dynamic profile, restore original iTerm2 profile
9. **Platform detection**: `TERM_PROGRAM == iTerm.app` check, stored in `POKEGENTS_HAS_ITERM`

---

## 10. Worktree Support

Git worktree isolation for agents working on the same repo without conflicts.

### Requirements

1. `pokegent <profile> -w <name>` creates or reuses a git worktree named `<name>`
2. The worktree is passed through to Claude via `--worktree <name>`
3. Each worktree gets its own isolated copy of the repo
4. Agents on different worktrees can work on the same codebase without merge conflicts

---

## 11. Configuration System

Single source of truth for all configurable values.

### Requirements

1. **Config file**: `~/.pokegents/config.json` with port, default profile, skip_permissions, iTerm2 restore profile
2. **Per-profile overrides**: `skip_permissions` can be set per-profile to override the global default
3. **Environment variables**: `POKEGENTS_DATA`, `POKEGENTS_DASHBOARD_URL` for advanced setups. Legacy `CCD_*` vars supported for backwards compatibility
4. **Config read by all components**: pokegent.sh, hooks (via env), Go server, MCP server
5. **Install creates default config** if not present. Never overwrites existing config

---

## 12. Installation & Updates

### Requirements

1. **Single installer**: `./install.sh` handles everything — deps, config, profiles, hooks, MCP, dashboard build, shell integration
2. **Dependency checking**: Required (jq, python3, curl) fail the install. Optional (node, go, claude) skip relevant steps with clear messages
3. **Safe hook merging**: APPEND to existing Claude Code hooks, never replace. Deduplicate by command path. Backup settings.json before modifying
4. **MCP registration**: Verify Claude CLI exists and supports `mcp add`. Print manual instructions on failure
5. **Idempotent**: Running install.sh multiple times is safe — doesn't overwrite profiles, config, or hooks
6. **Update flow**: `git pull && ./install.sh` — rebuilds dashboard, re-registers hooks, preserves all user data
7. **Health check**: `pokegent doctor` validates deps, data dirs, hooks, MCP, dashboard binary, search index

---

## 13. Notification System

macOS notifications when agents need attention.

### Requirements

1. Notify via `terminal-notifier` when an agent finishes (done) or needs input (permission request)
2. Pokemon sprite as notification icon (matched to agent's assigned sprite)
3. 30s debounce per session to prevent notification spam
4. Click notification to focus the agent's terminal

---

## 14. Search System

Full-text search across all past Claude Code conversations.

### Requirements

1. **SQLite FTS5** index built from JSONL transcript files
2. **Indexes**: session ID, project directory, custom title, user messages, assistant messages
3. **Background indexer**: Rebuilds every 5 minutes. Can be forced via `pokegents-dashboard index`
4. **API**: Search by query string with pagination (limit + offset). Returns highlighted snippets
5. **Recent sessions**: List most recent sessions across all profiles for the resume picker
6. **Display name enrichment**: Active sessions show dashboard display names, not stale JSONL titles
