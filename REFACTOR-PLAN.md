# Pokegents Refactor — Execution Plan

## Ground Rules

1. **One owner per file.** Every file has exactly one agent who writes to it. Others review but do NOT edit. This prevents merge conflicts and stepping on each other's work.
2. **Review gates between phases.** No phase starts until the previous phase's integration test passes and all agents confirm.
3. **Integration points are explicit.** When one agent's work depends on another's interface, the interface is agreed FIRST (in this doc), then implemented independently.
4. **Build must pass after every commit.** `go build`, `bash -n hooks/*.sh`, `npm run build` — all green before moving on.
5. **No renaming files that another agent owns.** If you need a function moved, tell the owner — don't do it yourself.

## Team

| Agent | ID | Specialty | Availability |
|-------|-----|-----------|-------------|
| **Pokegent GOD** | 84b4093d | Architecture, coordination, shell scripts, hooks | Lead |
| **UI Specialist** | 1cc16f9c | Go server, React frontend, state management | Go + frontend |
| **Messaging** | 10720341 | MCP server, hooks, messaging pipeline | Node + bash |
| **Refactor** | 9be91791 | Full-stack, deep system context | Flex |

---

## Phase 1: Extract Store (Layer 0)

**Goal:** All file I/O goes through a `store` package. No business logic changes. Everything works exactly as before.

**Duration:** 1 review cycle

### File Ownership

| New File | Owner | Creates | Content |
|----------|-------|---------|---------|
| `dashboard/server/store/store.go` | Refactor | Interface definitions | RunningStore, StatusStore, ProfileStore, ConfigStore, MessageStore, ActivityStore, TranscriptStore interfaces (ALL defined upfront, implemented incrementally) |
| `dashboard/server/store/filestore.go` | Refactor | Implementation | Wraps existing file I/O from state.go (loadRunning, loadStatuses, loadProfiles, etc.). Per-sub-store mutex. Atomic writes. |
| `dashboard/server/store/watcher.go` | UI Specialist | Move from server/ | Move existing watcher.go, add debouncing (50ms), single Watch() channel, 5-10s reconciliation sweep |
| `dashboard/server/store/transcript.go` | Refactor | Extract from state.go | extractContextUsage, extractTraceFromTranscript, extractLastUserPrompt |

### Existing Files Modified

| File | Owner | Changes |
|------|-------|---------|
| `dashboard/server/state.go` | UI Specialist | Remove file I/O functions (they moved to store/). StateManager now takes a Store interface in constructor. Calls `store.Running().Get()` instead of `os.ReadFile()`. |
| `dashboard/server/server.go` | UI Specialist | NewServer creates Store, passes to StateManager. No handler logic changes. |
| `dashboard/server/messages.go` | UI Specialist | Replace direct file I/O with Store.Messages() calls. |

### Files NOT touched (yet)
- hooks/*.sh — no changes this phase
- mcp/server.js — no changes this phase
- pokegent.sh — no changes this phase
- dashboard/web/src/** — no changes this phase

### Interface Contract (agree before implementing)

```go
// store/store.go

type Store struct {
    Running   RunningStore
    Status    StatusStore
    Profiles  ProfileStore
    Config    ConfigStore
    Messages  MessageStore
    Activity  ActivityStore
}

type RunningStore interface {
    Get(sessionID string) (*RunningSession, error)
    List() ([]RunningSession, error)
    Create(rs RunningSession) error
    Update(sessionID string, fn func(*RunningSession)) error // atomic read-modify-write
    Delete(sessionID string) error
    Watch() <-chan FileEvent
}

type StatusStore interface {
    Get(sessionID string) (*StatusFile, error)
    Upsert(sf StatusFile) error
    Delete(sessionID string) error
    Watch() <-chan FileEvent
}

type ProfileStore interface {
    Get(name string) (*Profile, error)
    List() ([]Profile, error)
}

type ConfigStore interface {
    Get() (*Config, error)
}

type FileEvent struct {
    Type      string // "create", "update", "delete"
    SessionID string
    Path      string
}
```

### Review Gate

Before Phase 2 starts:
- [ ] `go build` passes
- [ ] Dashboard loads and shows all agents correctly
- [ ] Messaging still works (send + receive)
- [ ] Agent status updates in real-time (SSE)
- [ ] Search works
- [ ] GOD reviews and approves

---

## Phase 2: Extract Core Engine (Layer 1)

**Goal:** Business logic moves out of state.go and server.go into focused core/ files.

**Duration:** 1 review cycle

### File Ownership

| New File | Owner | Content |
|----------|-------|---------|
| `dashboard/server/core/sessions.go` | UI Specialist | SessionManager: GetAgents, GetAgent, RenameAgent, CleanStale, ReconcileRunningFiles, rebuildAgents |
| `dashboard/server/core/hooks.go` | Refactor | HookProcessor: UpdateFromEvent (state machine), ProcessHookEvent. Single canonical state machine. |
| `dashboard/server/core/identity.go` | Refactor | resolveSessionID, resolveToCCDSessionID. ONE implementation. |

### Existing Files Modified

| File | Owner | Changes |
|------|-------|---------|
| `dashboard/server/state.go` | UI Specialist | Becomes thin — delegates to core/sessions.go. May be removed entirely if SessionManager replaces it. |
| `dashboard/server/server.go` | UI Specialist | Handlers call core.SessionManager instead of state.StateManager. resolveSessionID calls moved to core.Identity. |

### Interface Contract

```go
// core/sessions.go
type SessionManager struct {
    store    *store.Store
    contexts map[string]ContextUsage    // survives rebuilds
    feeds    map[string][]ActivityItem  // survives rebuilds
}

func (sm *SessionManager) GetAgents() []AgentState
func (sm *SessionManager) GetAgent(id string) *AgentState  // resolves any ID type
func (sm *SessionManager) RenameAgent(id, name string) error
func (sm *SessionManager) CleanStale() bool
func (sm *SessionManager) Rebuild()  // triggered by Store.Watch()

// core/identity.go
func ResolveToSessionID(store *store.Store, id string) string
func ResolveToCCDSessionID(store *store.Store, id string) string
```

### Review Gate

- [ ] `go build` passes
- [ ] All API responses identical to pre-refactor
- [ ] State machine transitions match (test: launch agent, do work, check status progression)
- [ ] Clone/fork still works (session ID reconciliation)
- [ ] GOD reviews core/hooks.go state machine against status-update.sh to verify they agree

---

## Phase 3: Extract Services (Layer 2)

**Goal:** Messaging, activity, search become independent service packages.

**Duration:** 1 review cycle

### File Ownership

| New File | Owner | Content |
|----------|-------|---------|
| `dashboard/server/services/messaging.go` | Messaging | MessagingService: Send, GetPending, Deliver, Consume, budget tracking, nudger integration |
| `dashboard/server/services/activity.go` | Messaging | ActivityService: RecordTurn, GetRecent, DetectOverlaps, rotation |
| `dashboard/server/services/search.go` | UI Specialist | SearchService: Search, RecentSessions, UpdateTitle, background indexer |

### Existing Files Modified

| File | Owner | Changes |
|------|-------|---------|
| `dashboard/server/messages.go` | Messaging | Moves to services/messaging.go. Old file deleted. |
| `dashboard/server/nudger.go` | Messaging | Merged into services/messaging.go (nudging is a messaging concern). Old file deleted. |
| `dashboard/server/search.go` | UI Specialist | Moves to services/search.go. Old file deleted. |
| `dashboard/server/server.go` | UI Specialist | Handlers delegate to services. Message handlers → MessagingService. Search handlers → SearchService. |

### Review Gate

- [ ] `go build` passes
- [ ] Send message from Agent A → Agent B works
- [ ] Auto-nudge fires for idle agents
- [ ] Activity log entries appear in dashboard
- [ ] Search returns results
- [ ] GOD reviews

---

## Phase 4: Slim server.go

**Goal:** server.go is only HTTP routing + middleware. Zero business logic.

**Duration:** Short — mostly deleting code that was already moved.

### File Ownership

| File | Owner | Changes |
|------|-------|---------|
| `dashboard/server/server.go` | UI Specialist | Remove all inline logic from handlers. Each handler is 5-10 lines: parse request → call service → write response. |
| `dashboard/server/sse.go` | UI Specialist | Extract SSE broadcasting (currently in events.go). Single broadcast point from Store.Watch() consumer. |

### Review Gate

- [ ] `go build` passes
- [ ] All API endpoints return same responses
- [ ] SSE fires once per state change (not 2-3x)
- [ ] GOD reviews server.go — should be <300 lines of pure routing

---

## Phase 5: Resilient hooks (file fallback, keep fast path)

**Goal:** Hooks work without the dashboard running, BUT keep the HTTP POST for low-latency SSE when the dashboard IS running. Best of both worlds.

**Important:** Do NOT remove the curl to dashboard. The hook does THREE things:
1. Write status file (ground truth — always)
2. POST to dashboard via dashboard-notify.sh (fast SSE — best effort)
3. Read messages from files IF dashboard POST fails (resilient fallback)

This keeps the current fast path (hook → POST → instant SSE) while adding resilience (dashboard down → file-based message delivery still works).

### File Ownership

| File | Owner | Changes |
|------|-------|---------|
| `hooks/status-update.sh` | GOD | Add file-based message reading as FALLBACK when dashboard curl fails. Try dashboard API first (fast path), fall back to reading `~/.pokegents/messages/{POKEGENTS_SESSION_ID}/` directly. |
| `hooks/dashboard-notify.sh` | GOD | Keep as-is (fire-and-forget POST for SSE low-latency). No changes needed. |
| `mcp/server.js` | Messaging | Add file-based fallback for list_agents and check_messages when dashboard API is unreachable. |

### Review Gate

- [ ] Dashboard running: message delivery works via API (fast path, <100ms)
- [ ] Stop the dashboard. Send a message via MCP. Start an agent. Agent sees the message on next prompt (file fallback).
- [ ] Restart dashboard. All state is correct (rebuilt from files).
- [ ] GOD reviews

---

## Phase 6: CLI cleanup

**Goal:** pokegent.sh is a thin orchestrator. Complex logic moves to helper files.

### File Ownership

| File | Owner | Changes |
|------|-------|---------|
| `pokegent.sh` | GOD | Main function becomes: config → profile → session → terminal → exec claude → cleanup. ~200 lines. |
| `lib/dashboard.sh` | GOD | Extract: dashboard start/stop/open/restart. |
| `lib/reload.sh` | GOD | Extract: reload command (snapshot → kill → rebuild → relaunch). iTerm2-guarded. |
| `lib/doctor.sh` | GOD | Extract: doctor command (dep checks, hook validation, etc.) |
| `lib/helpers.sh` | GOD | Extract: sprite selection, session resolution, history management. |

### Review Gate

- [ ] `pokegent <profile>` works
- [ ] `pokegent dashboard start/stop/open` works
- [ ] `pokegent reload` works
- [ ] `pokegent doctor` works
- [ ] `pokegent ls`, `pokegent edit` work
- [ ] GOD reviews

---

## Conflict Prevention Rules

### The "One Writer" rule

Every file has exactly ONE agent who writes to it. If you need a change in someone else's file, send them a message with the exact change needed. They make it.

| File/Directory | Writer | Reviewers |
|----------------|--------|-----------|
| `store/store.go` | Refactor | GOD, UI Specialist |
| `store/filestore.go` | Refactor | GOD, UI Specialist |
| `store/watcher.go` | UI Specialist | GOD |
| `store/transcript.go` | Refactor | GOD, UI Specialist |
| `core/sessions.go` | UI Specialist | GOD, Refactor |
| `core/hooks.go` | Refactor | GOD, Messaging |
| `core/identity.go` | Refactor | GOD, Messaging |
| `services/messaging.go` | Messaging | GOD, UI Specialist |
| `services/activity.go` | Messaging | GOD |
| `services/search.go` | UI Specialist | GOD |
| `server.go` | UI Specialist | GOD |
| `sse.go` | UI Specialist | GOD |
| `main.go` | UI Specialist | GOD |
| `hooks/status-update.sh` | GOD | Messaging |
| `hooks/statusline.sh` | GOD | — |
| `hooks/dashboard-notify.sh` | GOD | — |
| `pokegent.sh` | GOD | Refactor |
| `lib/*.sh` | GOD | Refactor |
| `mcp/server.js` | Messaging | GOD |
| `install.sh` | GOD | Messaging |
| `dashboard/web/src/**` | UI Specialist | — |
| `ARCHITECTURE.md` | GOD | All |
| `REQUIREMENTS.md` | GOD | All |
| `CLAUDE.md` | GOD | All |
| `README.md` | GOD | All |

### Integration Protocol

When your work depends on another agent's interface:

1. **Propose** the interface in a message (function signatures, types, behavior)
2. **Wait for ACK** — the other agent confirms or suggests changes
3. **Implement independently** — each agent codes to the agreed interface
4. **Integration test** — GOD verifies both sides work together
5. **Commit** — only after integration passes

### Commit Protocol

- Each phase gets ONE integration commit after the review gate passes
- Agents can make WIP commits on their own files during a phase
- GOD does the final integration commit that merges all agents' work
- Build must pass (`go build && bash -n hooks/*.sh`) before any commit

---

## Execution Order (revised after External Review)

**Key changes from v1:**
- Phase 0 added: resilience FIRST (file-based fallback before refactoring)
- Phase 0.5 added: tests BEFORE refactoring (Go unit tests for Store and Core)
- UI Specialist load rebalanced: Refactor agent takes store/filestore.go and store/transcript.go
- Review gates strengthened with specific test scenarios
- `set -e` bug on hook line 302 fixed in Phase 0

```
Phase 0 (Resilience + bug fixes) — BEFORE any refactoring
  GOD: fix set -e on status-update.sh line 302 (re-enabled after reconciliation block)
  GOD: add file-based message fallback to status-update.sh
  Messaging: add file-based fallback to mcp/server.js
  Refactor: fix any pending pokegent.sh bugs (tilde expansion, etc.)
  GATE: dashboard down → send message → agent sees it on next prompt

Phase 0.5 (Tests) — BEFORE refactoring Go code
  Refactor: Go unit tests for state machine transitions (hooks_test.go)
  Refactor: Go unit tests for session ID resolution (identity_test.go)
  Refactor: cross-language integration test — bash pipes test JSON into hook,
            Go test calls ApplyEvent with same input, asserts same state output
  UI Specialist: Go unit tests for Store file I/O (store_test.go)
  GATE: go test ./... passes

Phase 1 (Store) — extract Layer 0
  Refactor: store/store.go (ALL interfaces defined upfront) + store/filestore.go + store/transcript.go
  UI Specialist: store/watcher.go (move + add debouncing + 5-10s reconciliation sweep)
  UI Specialist: update state.go, server.go, messages.go to use Store
  GATE: go test ./... passes, dashboard shows agents, SSE fires, search works
  GATE SCENARIOS:
    - Launch agent → appears in dashboard within 2s
    - Rename agent → name updates in dashboard + iTerm tab
    - Clone agent → both original and clone appear
    - Kill agent → disappears from dashboard within 30s

Phase 2 (Core) — extract Layer 1
  Refactor: core/types.go (SessionState enum, SessionIdentity, HookEvent)
  Refactor: core/hooks.go (canonical state machine — ApplyEvent function)
  Refactor: core/identity.go (session ID resolution — single Go implementation)
  UI Specialist: core/sessions.go (SessionManager using Store)
  UI Specialist: update state.go → thin facade delegating to core/sessions
  GATE: go test ./... passes, all Phase 1 scenarios still work
  GATE SCENARIOS:
    - Agent goes idle→busy→done (state machine)
    - Clone fires SessionStart → original NOT overwritten (SKIP state)
    - PermissionRequest → needs_input (not from idle_prompt)
    - /compact → compacting → done with "Compacted" summary

Phase 3 (Services) — extract Layer 2
  Messaging: services/messaging.go (Send, Deliver, Consume, budget, nudger)
  Messaging: services/activity.go (RecordTurn, GetRecent, DetectOverlaps)
  UI Specialist: services/search.go (Search, RecentSessions, UpdateTitle)
  UI Specialist: update server.go handlers to delegate to services
  GATE: go test ./... passes
  GATE SCENARIOS:
    - Agent A sends message to Agent B → B receives on next prompt
    - Clone A sends to Clone B (same parent) → correct routing
    - Agent finishes turn → activity log entry appears
    - Activity overlap warning when 2 agents edit same file
    - Search returns results with correct display names

Phase 4 (Slim server) — thin HTTP gateway
  UI Specialist: slim server.go (each handler 5-10 lines)
  UI Specialist: extract sse.go (single SSE broadcast point from Store.Watch)
  GATE: server.go < 300 lines, all previous scenarios pass
  GATE SCENARIOS:
    - SSE fires exactly once per state change (not 2-3x)
    - Dashboard restart → all agents reappear with correct state

Phase 5 (CLI cleanup) — runs AFTER Phase 4
  GOD: split pokegent.sh into lib/dashboard.sh, lib/reload.sh, lib/doctor.sh, lib/helpers.sh
  GOD: pokegent.sh main function < 200 lines
  GATE: all pokegent subcommands work (ls, edit, dashboard, reload, doctor, -r, -w, -c)
```

**Load distribution:**

| Agent | Phase 0 | Phase 0.5 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|-------|---------|-----------|---------|---------|---------|---------|---------|
| GOD | hooks | — | review | review | review | review | CLI split |
| UI Specialist | — | store tests | interfaces + wiring | sessions | search + handlers | server slim | — |
| Messaging | MCP fallback | — | — | — | messaging + activity | — | — |
| Refactor | bug fixes | state machine + ID tests | filestore + transcript | types + hooks + identity | — | — | — |

**Estimated total:** 7 phases. Phases 0 and 0.5 are quick (1 cycle each). Phases 1-4 are the core refactor (1 cycle each). Phase 5 is independent cleanup.
