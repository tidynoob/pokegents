# Pokegents — Architecture Plan

## Design Principles

1. **Layered dependencies** — each layer only depends on layers below it, never above
2. **Swappable integrations** — terminal (iTerm2/kitty/tmux), UI (web/TUI), notifications (macOS/Slack) are all adapters behind interfaces
3. **Files are the ground truth** — the file system (`~/.pokegents/`) is the single source of truth. The Go Store is the canonical reader/writer for Go code, but Bash hooks are a co-equal writer with flock-based coordination (see "Two-Writer Model" below)
4. **Crash resilience** — no component failure should cascade (dashboard down ≠ broken sessions)
5. **Independent deployability** — the dashboard, MCP server, and CLI should function independently

## Current Problems

| Problem | Impact |
|---------|--------|
| `server.go` is a god object (100+ StateManager calls) | Can't change anything without touching server.go |
| 3 independent writers to running/status files (shell, hook, server) | Race conditions, stale reads, lost updates |
| Transcript parsing duplicated 4x (shell, hook, Go server, MCP) | Bugs fixed in one place regress in another |
| Session resolution duplicated 4x | Same |
| Terminal ops are blocking HTTP handlers | Dashboard UI freezes when AppleScript hangs |
| MCP server hard-depends on dashboard API | Messaging dies when dashboard restarts |
| Hook curls dashboard for message delivery | Silent failure when dashboard is down |

## Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4: User Interfaces                               │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ CLI          │  │ Web Dashboard│  │ (future: TUI) │ │
│  │ pokegent.sh  │  │ React + SSE  │  │               │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────────┘ │
├─────────┼──────────────────┼────────────────────────────┤
│  Layer 3: Integration Adapters (swappable)              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ iTerm2       │  │ macOS Notify │  │ (future:      │ │
│  │ Terminal     │  │ Notifier     │  │  kitty/tmux)  │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────────┘ │
├─────────┼──────────────────┼────────────────────────────┤
│  Layer 2: Services                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Messaging    │  │ Activity Log │  │ Search        │ │
│  │ Service      │  │ Service      │  │ Service       │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘ │
├─────────┼──────────────────┼─────────────────┼──────────┤
│  Layer 1: Core Engine                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Session      │  │ Profile      │  │ Hook          │ │
│  │ Manager      │  │ Manager      │  │ Processor     │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘ │
├─────────┼──────────────────┼─────────────────┼──────────┤
│  Layer 0: Storage                                       │
│  ┌─────────────────────────────────────────────────────┐│
│  │ File Store (running/, status/, profiles/, messages/) ││
│  │ With locking, atomic writes, and change events      ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

## Two-Writer Model (important architectural constraint)

The Go Store CANNOT be the only writer. Bash hooks write status files, running files, activity logs, and message budget files. Hooks are synchronous (Claude blocks until they return) so they can't call a Go API — they must write files directly.

**This means we have two independent writers:**

| Writer | Language | Files it writes | Coordination |
|--------|----------|----------------|--------------|
| Go Store | Go | running/ (rename), messages/, name-overrides | Atomic write (tmp+rename), fsnotify to detect external changes |
| Bash hooks | Bash | status/, running/ (patch session_id), activity/, budget | Atomic write (tmp+rename), flock where possible |

**Rules to prevent races:**
1. **Status files:** Hook is the sole writer. Go server reads only.
2. **Running files:** Hook patches `session_id` and `claude_pid` on SessionStart. Go server patches `display_name` on rename. Different fields → no conflict if both use atomic writes.
3. **Activity log:** Hook is the sole appender. Go server reads only.
4. **Message files:** Go server (via MessagingService) creates messages. Hook reads and marks delivered. MCP deletes on consume.
5. **Message budget:** Hook resets on UserPromptSubmit. MCP increments on send. Different files per agent → no conflict.

**What we CANNOT unify:**
- State machine logic exists in Bash (hook) AND Go (server's UpdateFromEvent). Both must implement the same transitions. We mitigate with: (a) canonical spec in ARCHITECTURE.md, (b) Go tests that verify transitions match, (c) hook is authoritative (writes files), server is a fast cache.
- Session ID resolution exists in Bash, Go, and Node. All three must follow: `ccd_session_id → session_id → TTY fallback`. Mitigated with cross-implementation test scenarios in review gates.

## Layer 0: Storage

**Purpose:** Abstract all file I/O behind a single interface for Go code. Bash hooks write files directly with atomic writes. The Go Store watches for external changes via fsnotify.

**Problem it solves:** Go code currently has raw os.ReadFile/WriteFile scattered across state.go, server.go, messages.go. Centralizing this in Store makes the Go side clean. Bash hooks continue writing directly (they must), but the Store detects their changes.

### Interface

```
Store
├── Running
│   ├── Get(sessionID) → RunningSession
│   ├── List() → []RunningSession
│   ├── Create(session) → error
│   ├── Update(sessionID, patch) → error  // atomic read-modify-write
│   ├── Delete(sessionID) → error
│   └── Watch() → chan Event              // file change notifications
├── Status
│   ├── Get(sessionID) → StatusFile
│   ├── Upsert(status) → error
│   ├── Delete(sessionID) → error
│   └── Watch() → chan Event
├── Profiles
│   ├── Get(name) → Profile
│   ├── List() → []Profile
│   └── Save(name, profile) → error
├── Config
│   └── Get() → Config
├── Messages
│   ├── Send(from, to, content) → Message
│   ├── GetPending(sessionID) → []Message
│   ├── MarkDelivered(msgID) → error
│   ├── Consume(sessionID) → []Message    // read + delete
│   ├── GetHistory() → []Message
│   ├── AppendHistory(msg) → error
│   ├── GetBudget(sessionID) → (used, max)
│   └── ResetBudget(sessionID) → error
├── Transcripts
│   ├── FindPath(sessionID) → string
│   ├── ExtractContext(path) → ContextUsage
│   ├── ExtractTrace(path) → string
│   ├── ExtractLastUserPrompt(path) → string
│   └── AppendCustomTitle(path, title) → error
└── Activity
    ├── Append(projectHash, entry) → error
    ├── ReadSince(projectHash, line) → []string
    └── GetLastRead(sessionID) → int
```

**Key rules:**
- All Go mutations go through `Store`. No direct `os.WriteFile` in Go code outside store/.
- Bash hooks write files directly with atomic writes (tmp + rename). This is by design — hooks can't call Go code.
- `Update` does atomic read-modify-write (read → apply patch → write to .tmp → rename)
- `Watch` uses fsnotify underneath but only emits after debouncing (50ms). Additionally, a 5-10s periodic reconciliation sweep catches any missed fsnotify events (macOS kqueue can miss under high write rates).
- `Running.Get(sessionID)` searches by filename glob `*-{sessionID}.json` (not just JSON content)

**Concurrency model:**
- Per-sub-store mutex (Running, Status, Messages, Activity each have independent locks)
- `Watch()` runs in its own goroutine, emits events on a channel
- Rebuild takes brief read locks on all sub-stores for a consistent snapshot
- HTTP handlers read through SessionManager which acquires locks internally
- High-frequency writers (Messages, Activity) have independent locks to avoid blocking agent state reads

**Error propagation:**
- Store mutation errors → HTTP 500 returned to caller
- Store read errors → return last-known-good data with a `degraded` flag (never silently serve stale data without signaling)
- Messaging Send failures → error returned to MCP caller (agent must know the message wasn't sent)
- Messaging Consume/Deliver failures → degrade gracefully (return empty list, not error)
- SSE → broadcast error event so frontend can show degraded state

---

## Layer 1: Core Engine

**Purpose:** Session lifecycle, profile management, state machine logic. No UI, no terminal, no messaging — pure business logic.

### Session Manager

Owns: session_id ↔ ccd_session_id mapping, running file lifecycle, stale detection, liveness checks.

```
SessionManager
├── Launch(profile, options) → Session
│   // Creates running file, generates session_id
│   // Returns session config (args for claude CLI)
│   // Does NOT start claude or set up terminal
├── Resume(profile, sessionID) → Session
├── Clone(profile, sessionID) → Session
├── GetActive() → []Session
├── GetByID(id) → Session              // resolves session_id OR ccd_session_id
├── Rename(sessionID, newName) → error // updates running file + transcript
├── Reconcile(claudeSessionID, ccdSessionID) → error
│   // Called by hook on SessionStart — patches running file
├── CleanStale() → []string           // returns removed session IDs
└── End(sessionID) → error            // removes running file + status
```

**Key change:** Session Manager does NOT:
- Start Claude (that's the CLI's job)
- Set terminal colors (that's the terminal adapter's job)
- Send messages (that's the messaging service's job)

### Profile Manager

Owns: profile CRUD, defaults, validation.

```
ProfileManager
├── Get(name) → Profile
├── List() → []Profile
├── Save(name, profile) → error
├── Delete(name) → error
└── GetDefault() → string             // from config
```

### Hook Processor

Owns: state machine transitions, event routing. Called by the hook shell script via file writes, and by the dashboard via HTTP events.

```
HookProcessor
├── ProcessEvent(event) → HookResponse
│   // Applies state machine rules
│   // Returns: new state, systemMessage (if any), status update
├── GetState(sessionID) → AgentState
└── GetAllStates() → []AgentState
```

**State machine rules live HERE, not scattered across status-update.sh AND server.go's UpdateFromEvent.** The hook script becomes a thin wrapper that reads stdin, calls the processor (via file write), and outputs the response.

---

## Layer 2: Services

**Purpose:** Higher-level features that build on the core engine.

### Messaging Service

Owns: message routing, delivery, budget, nudge decision logic. Note: MessagingService does NOT import terminal/. `Send()` returns `(msg, needsNudge bool)`. The server handler (Layer 4) checks `needsNudge` and calls `TerminalAdapter.WriteText()`. Batch delay (2s) and debounce (10s) timers stay inside MessagingService.

```
MessagingService
├── Send(from, to, content) → Message
├── GetPending(sessionID) → []Message  // resolves both ID types
├── Deliver(sessionID) → []Message     // marks delivered, returns content
├── Consume(sessionID) → []Message     // read + delete
├── GetBudget(sessionID) → (used, max)
├── ResetBudget(sessionID)
└── GetConnections() → []Connection
```

**Key change:** The messaging service handles ID resolution internally. Callers pass whatever ID they have (session_id, ccd_session_id, 8-char prefix) and the service resolves it.

**MCP server becomes a thin wrapper:** list_agents → SessionManager.GetActive(), send_message → MessagingService.Send(), check_messages → MessagingService.Consume().

### Activity Log Service

Owns: per-project activity tracking, overlap detection.

```
ActivityService
├── RecordTurn(sessionID, agentName, files, summary)
├── GetRecent(projectHash, sinceLineN, excludeSession) → []Entry
├── DetectOverlaps(projectHash, myFiles) → []Warning
└── GetProjectHash(cwd) → string
```

### Search Service

Owns: FTS5 indexing, session browsing, display name enrichment.

```
SearchService
├── Search(query, limit, offset) → ([]Result, total)
├── RecentSessions(limit) → []Result
├── IndexAll()
├── UpdateTitle(sessionID, title)
└── StartBackgroundIndexer(interval)
```

---

## Layer 3: Integration Adapters

**Purpose:** Platform-specific operations behind swappable interfaces. Each adapter is registered at startup; the rest of the system doesn't know which implementation is active.

### Terminal Adapter

```
TerminalAdapter interface {
    IsAvailable() → bool
    SetTabColor(r, g, b int) → error
    SetTabTitle(title string) → error
    FocusSession(sessionRef) → error
    WriteText(sessionRef, text string) → error
    SetTabName(sessionRef, name string) → error
    OpenNewTab(command string) → error
    CloseSession(sessionRef) → error
    SetSpriteIcon(sessionRef, spritePath string) → error
}
```

**Implementations:**
- `iTerm2Adapter` — AppleScript-based (macOS only, build tag `darwin`)
- `StubAdapter` — no-ops with clear log messages (all platforms)
- Future: `KittyAdapter`, `TmuxAdapter`, `WezTermAdapter`

**Key change:** pokegent.sh also uses this abstraction. The shell script calls a helper (`_pokegent_terminal_set_color`) that checks `POKEGENTS_HAS_ITERM` and delegates. Currently the iTerm2 code is inlined everywhere.

### Notification Adapter

```
NotificationAdapter interface {
    Notify(title, message, iconPath string) → error
    IsAvailable() → bool
}
```

**Implementations:**
- `MacOSNotifier` — terminal-notifier with sprite icons
- `StubNotifier` — logs to stderr
- Future: `SlackNotifier`, `DiscordNotifier`

---

## Layer 4: User Interfaces

### CLI (`pokegent.sh`)

The shell function becomes a thin orchestrator:

```
pokegent <profile>
  1. ProfileManager.Get(profile)          // Layer 1
  2. SessionManager.Launch(profile)       // Layer 1 — creates running file
  3. TerminalAdapter.SetTabColor(...)     // Layer 3 — iTerm2 theming
  4. TerminalAdapter.SetTabTitle(...)     // Layer 3
  5. exec claude $args                    // actually start Claude
  6. SessionManager.End(session)          // Layer 1 — cleanup on exit
  7. TerminalAdapter.Restore()            // Layer 3
```

**What moves OUT of pokegent.sh:**
- Stale session cleanup → SessionManager.CleanStale()
- Transcript parsing for resume names → SearchService or SessionManager
- Sprite selection → separate helper
- Dashboard start/stop → separate script
- Doctor → separate script

**What stays:**
- Argument parsing and subcommand routing
- The actual `exec claude` invocation
- Shell-specific environment setup

### Dashboard Server

The Go HTTP server becomes a thin API gateway:

```
DashboardServer
├── Uses: SessionManager, MessagingService, ActivityService, SearchService
├── Uses: TerminalAdapter, NotificationAdapter
├── Provides: REST API, SSE stream, static file serving
└── Owns: NOTHING — all logic delegated to services
```

**Current server.go responsibilities and where they move:**

| Current | Moves to |
|---------|----------|
| State merging (rebuildAgents) | SessionManager + Store |
| Transcript polling | Core Engine (background worker) |
| Stale cleanup | SessionManager.CleanStale() |
| File watching | Store.Watch() |
| Message routing | MessagingService |
| Activity log reading | ActivityService |
| Session resolution | SessionManager.GetByID() |
| Terminal operations | TerminalAdapter |
| Notifications | NotificationAdapter |
| Search | SearchService |
| Nudging | MessagingService (decision) + server handler (terminal call) |

### Web Frontend (React)

No architectural changes needed. It already consumes the REST API and SSE stream. The API contract stays the same — only the server internals change.

### MCP Server (`mcp/server.js`)

Becomes a thin wrapper:
- `list_agents` → GET /api/sessions
- `send_message` → POST /api/messages
- `check_messages` → POST /api/messages/consume/{id}

**Key change:** If dashboard is down, the MCP server falls back to reading Store files directly.

#### MCP Fallback Contract (implemented in Phase 0)

**Detection:** Each API call has a 2s timeout (AbortController). On timeout or connection refused, the tool switches to file mode. After a failure, API calls are skipped for 30s (backoff) to avoid 2s delays on every tool call.

**`list_agents` fallback:**
- Scan `~/.pokegents/running/*.json`
- Parse fields: `profile`, `session_id`, `ccd_session_id`, `display_name`, `tty`
- For state: read `~/.pokegents/status/{session_id}.json`, parse `state`, `detail`, `user_prompt`
- Return same shape as `/api/sessions` response

**`check_messages` fallback:**
- Resolve own session ID from `POKEGENTS_SESSION_ID` env var (always set by pokegent.sh)
- Read all `~/.pokegents/messages/{ccd_session_id}/*.json` (skip files starting with `_` like `_msg_budget`)
- Sort by `timestamp` field
- Delete each file after reading (consume semantics)
- Return same shape as `/api/messages/consume/{id}` response

**`send_message` fallback:**
- Resolve recipient by scanning `~/.pokegents/running/*.json` for `ccd_session_id` prefix match
- Generate message ID: `Date.now() * 1e6 + random(0, 1e6)`
- Write JSON to `~/.pokegents/messages/{to_ccd_session_id}/{id}.json`
- Fields: `id`, `from`, `from_name`, `to`, `to_name`, `content`, `timestamp` (ISO 8601), `delivered: false`
- Budget tracking unchanged (file-based, always works)

**ID resolution without API:**
- `resolveAgent` scans running files for `ccd_session_id` prefix match, falls back to `session_id` prefix
- Claude PID fallback: matches `process.ppid` against `claude_pid` field in running files

---

## Hook Script Architecture

The hook (`status-update.sh`) is the bridge between Claude Code and pokegents. It can't depend on the Go server being running.

### Current problems:
1. Duplicates state machine logic that also exists in server.go's UpdateFromEvent
2. Curls the dashboard for message delivery (fails silently when down)
3. Runs Python for transcript parsing (slow, adds dependency)

### Target:
```
status-update.sh
  1. Read event from stdin (jq)
  2. Write state transition to status file (atomic write with fallback)
  3. Write activity log entry on Stop (append)
  4. Read pending messages from file store (NOT from dashboard API)
  5. Output systemMessage if messages/activity pending
  6. Fire-and-forget HTTP POST to dashboard (optional, for low-latency SSE)
```

**Key change:** Message delivery reads from `~/.pokegents/messages/{id}/` directly instead of curling the dashboard. The hook becomes fully self-contained — it works even with no dashboard running.

---

## File & Directory Layout (post-refactor)

```
pokegents/
├── pokegent.sh                    # CLI entry point (thin orchestrator)
├── install.sh                     # Installer
├── REQUIREMENTS.md                # Feature requirements
├── ARCHITECTURE.md                # This document
├── CLAUDE.md                      # Claude Code instructions
├── README.md                      # User docs
│
├── hooks/
│   ├── status-update.sh           # Claude Code hook (self-contained)
│   ├── dashboard-notify.sh        # Optional: forward events to dashboard
│   └── statusline.sh              # Claude status bar renderer
│
├── defaults/
│   ├── config.json
│   └── profiles/
│
├── mcp/
│   ├── server.js                  # MCP messaging server (thin wrapper)
│   └── package.json
│
└── dashboard/
    ├── main.go                    # Entry point
    ├── Makefile
    ├── server/
    │   ├── server.go              # HTTP routes only (thin gateway)
    │   ├── sse.go                 # SSE event broadcasting
    │   │
    │   ├── core/                  # Layer 1: Core Engine
    │   │   ├── sessions.go        # SessionManager
    │   │   ├── profiles.go        # ProfileManager
    │   │   ├── hooks.go           # HookProcessor (state machine)
    │   │   └── identity.go        # Session ID resolution (single impl)
    │   │
    │   ├── services/              # Layer 2: Services
    │   │   ├── messaging.go       # MessagingService + nudger
    │   │   ├── activity.go        # ActivityService
    │   │   └── search.go          # SearchService
    │   │
    │   ├── store/                 # Layer 0: Storage
    │   │   ├── store.go           # Interface definitions
    │   │   ├── filestore.go       # File-based implementation
    │   │   └── watcher.go         # fsnotify wrapper with debouncing
    │   │
    │   └── terminal/              # Layer 3: Terminal Adapters
    │       ├── terminal.go        # Interface
    │       ├── iterm2.go          # iTerm2 (darwin build tag)
    │       └── stub.go            # Stub (!darwin)
    │
    └── web/                       # Layer 4: Web Frontend
        ├── src/
        └── public/
```

---

## Migration Strategy

This refactor is large. Do it in phases, keeping the system working at every step. No backwards compatibility needed — Thariq is the only user and hasn't released yet. Breaking changes are fine.

See **REFACTOR-PLAN.md** for the detailed execution plan with phase assignments, file ownership, and review gates.

---

## What This Enables

| Scenario | Before | After |
|----------|--------|-------|
| Swap iTerm2 for Kitty | Rewrite 200+ lines across 3 files | Add `terminal/kitty.go`, register it |
| Replace web dashboard with TUI | Impossible | Build new TUI that consumes same REST API |
| Dashboard restarts | Messaging breaks, agents disappear | Hooks keep working, MCP falls back to files |
| Add Slack notifications | Modify notifications.go internals | Add `SlackNotifier`, register it |
| Multiple dashboards | Port conflicts, state races | Multiple readers of same Store, SSE fan-out |
| New state (e.g. "reviewing") | Edit hook, server.go, frontend | Edit `core/hooks.go` state machine, frontend auto-discovers |

## Key Design Decisions (from team review)

1. **Dual-path state updates:** Hook writes files (ground truth, works without dashboard). Dashboard-notify.sh POSTs to server (low-latency SSE). Server's in-memory state is a fast cache; file watcher reconciles. Don't make HTTP trigger file re-reads — too slow.

2. **SSE broadcast from ONE place:** Currently fired from 5 scattered locations. Move to a single publish point in the Store.Watch() consumer. All state mutations flow through Store → Watch event → rebuild → SSE broadcast.

3. **rebuildAgents() stays as full rebuild** (not incremental). It's fast (<1ms for 15 agents). Store.Watch() debounces multiple file changes into one rebuild instead of 2-3 per hook event.

4. **Transcript parsing lives in Store** (Layer 0). It's data access. The callers (trace poller, context backfill) are business logic in Core (Layer 1).

5. **Session ID resolution: 3 implementations must agree.** Bash (hook), Go (server), and Node (MCP) each have their own resolution logic. All must follow the same priority: `ccd_session_id → session_id → TTY fallback`. Cross-implementation testing required.

6. **MCP file-based fallback:** When dashboard is down, MCP scans running files directly for list_agents and reads message files for check_messages. The file store IS the single source of truth; the API is a convenience layer.

7. **No backwards compatibility needed.** Thariq is the only user, hasn't released. Breaking changes are fine. No migration scripts needed.
