# Pokegents Decoupling Spec: Multi-Backend Architecture

## Vision

pokegents is a generic multi-agent orchestration wrapper for coding agents. It manages agent identity, inter-agent messaging, visual dashboards (Pokemon theme), task groups, and session history. The AI backend and terminal are pluggable:

```
pokegent -> iTerm2 + Claude Code     (default, current)
pokegent -> tmux + Codex CLI         (cross-platform)
pokegent -> Kitty + Gemini CLI       (Linux)
pokegent -> headless + Agent SDK     (CI/daemon)
pokegent -> any terminal + any agent CLI
```

This document specifies the interface design and architecture. Only Claude Code + iTerm2 will be implemented initially, but the abstractions must support other backends without rearchitecture.

---

## Three-Layer Architecture

```
+-------------------------------------------------------+
|                   POKEGENT CORE                        |
|  Agent identity (pokegent_id) | Messaging | Dashboard  |
|  Task groups | Sprites | Grid layout | Session history |
|  PC Box | MCP coordination | Activity feed            |
+-------------------------------------------------------+
         |                           |
    Agent Backend              Terminal Backend
    (AI CLI or API)            (how agents run)
         |                           |
  +-----------+              +-----------+
  | Claude CC |              |  iTerm2   |
  | Codex CLI |              |   tmux    |
  | Gemini    |              |  Kitty    |
  | Agent SDK |              | Headless  |
  | Amazon Q  |              | WezTerm   |
  +-----------+              +-----------+
```

**Layer 1: Agent Backend** -- launches and communicates with AI agents
**Layer 2: Terminal Backend** -- manages terminal sessions and tabs
**Layer 3: Pokegent Core** -- orchestration, identity, UI (zero coupling to backends)

---

## Agent Backend Interface

```go
type AgentBackend interface {
    // Identity
    Name() string                        // "claude-code", "codex", "gemini", etc.
    Capabilities() BackendCapabilities

    // Session lifecycle
    Launch(cfg LaunchConfig) (AgentHandle, error)
    Resume(sessionRef string) (AgentHandle, error)
    Fork(sessionRef string) (AgentHandle, error)
    Shutdown(handle AgentHandle) error

    // Session discovery
    FindSession(query string) ([]SessionRef, error)  // search by prefix, name, etc.
    ListSessions() ([]SessionRef, error)

    // Liveness
    IsAlive(handle AgentHandle) bool

    // Communication (for headless/API backends)
    SendPrompt(handle AgentHandle, prompt string) error

    // Hooks/Events
    EventStream() <-chan AgentEvent       // push-based (Claude, Gemini)
    PollStatus(handle AgentHandle) AgentStatus  // pull-based fallback (Aider)

    // Transcript access
    GetTranscript(handle AgentHandle) (TranscriptReader, error)

    // Context migration (for switching between backends)
    ExportContext(handle AgentHandle) (*ContextMigration, error)
    ImportContext(cfg LaunchConfig, ctx *ContextMigration) (AgentHandle, error)

    // Configuration
    CLIPath() string                      // path to CLI binary
    CLIArgs(cfg LaunchConfig) []string    // build CLI arguments
    SettingsPath() string                 // where to register hooks
    RegisterHooks(hookPaths HookPaths) error
}

type BackendCapabilities struct {
    SupportsResume      bool
    SupportsFork        bool
    SupportsHooks       bool   // push-based events
    SupportsPolling     bool   // pull-based fallback
    SupportsMCP         bool
    SupportsSubagents   bool
    SupportsCompaction  bool
    SupportsPermissions bool
    SupportsThinking    bool   // Claude-specific thinking blocks
    SupportsStreaming   bool
    MaxContextWindow    int
}

type LaunchConfig struct {
    PokegentID   string
    DisplayName  string
    CWD          string
    SystemPrompt string
    Model        string
    Effort       string
    AddDirs      []string
    EnvVars      map[string]string  // pokegent env vars passed to agent
}

type AgentHandle struct {
    PokegentID     string  // stable pokegent identity
    Backend        string  // "claude-code", "codex", "gemini", "api", etc.
    BackendID      string  // backend-specific session ID (Claude conversation ID, etc.)
    PID            int     // process ID (0 for API backends)
    TTY            string  // terminal device (empty for headless)
}

type AgentEvent struct {
    PokegentID  string
    EventType   EventType  // generic event enum
    Detail      string
    ToolName    string
    ToolInput   map[string]any
    Timestamp   time.Time
    Raw         json.RawMessage  // backend-specific payload
}
```

### Generic Event Types

All backends map their native events to these generic types. The mapping is per-backend:

```go
type EventType int
const (
    EventSessionStart EventType = iota
    EventSessionEnd
    EventTurnStart        // user sent a prompt
    EventTurnEnd          // agent finished responding
    EventToolStart        // before tool execution
    EventToolEnd          // after tool execution
    EventToolError        // tool failed
    EventPermissionNeeded // agent needs user approval
    EventIdle             // agent waiting for input
    EventError            // API error, crash, etc.
    EventSubagentStart    // sub-agent spawned
    EventSubagentEnd      // sub-agent completed
    EventCompaction       // context was compacted
)
```

### Event Mapping Per Backend

| Generic Event | Claude Code | Codex | Gemini | Amazon Q | API/SDK |
|--------------|-------------|-------|--------|----------|---------|
| SessionStart | SessionStart | SessionStart | SessionStart | agentSpawn | on connect |
| SessionEnd | SessionEnd | (process exit) | SessionEnd | (process exit) | on disconnect |
| TurnStart | UserPromptSubmit | UserPromptSubmit | BeforeAgent | userPromptSubmit | on send |
| TurnEnd | Stop | Stop | AfterAgent | stop | on complete |
| ToolStart | PreToolUse | PreToolUse | BeforeTool | preToolUse | on tool_use |
| ToolEnd | PostToolUse | PostToolUse | AfterTool | postToolUse | on tool_result |
| ToolError | PostToolUseFailure | (exit code) | AfterTool (error) | (exit code) | on error |
| PermissionNeeded | PermissionRequest | (not supported) | (not supported) | (not supported) | N/A |
| Idle | Notification(idle) | (not supported) | Notification | (not supported) | N/A |
| SubagentStart | SubagentStart | (not supported) | (not supported) | (not supported) | on spawn |
| SubagentEnd | SubagentStop | (not supported) | (not supported) | (not supported) | on complete |

### Backends Without Hooks

Codex has hooks but they are limited (Bash tool only, disabled on Windows). Aider has no hooks at all. For these backends, pokegents uses polling:

```go
type PollingAdapter struct {
    backend    AgentBackend
    interval   time.Duration  // 2-5 seconds
    lastStatus map[string]AgentStatus
}

// Polling detects state changes by comparing snapshots
func (p *PollingAdapter) EventStream() <-chan AgentEvent {
    ch := make(chan AgentEvent)
    go func() {
        for {
            for id, handle := range p.tracked {
                status := p.backend.PollStatus(handle)
                if status != p.lastStatus[id] {
                    ch <- p.diffToEvent(id, p.lastStatus[id], status)
                    p.lastStatus[id] = status
                }
            }
            time.Sleep(p.interval)
        }
    }()
    return ch
}
```

---

## Transcript Interface

Each backend stores transcripts differently. The interface abstracts the format:

```go
type TranscriptReader interface {
    // Path to transcript file (empty for in-memory/API backends)
    Path() string

    // Extract structured data
    ContextUsage() (tokens int, window int, err error)
    LastUserPrompt() (string, error)
    LastAssistantMessage() (string, error)
    ActivityFeed(since time.Time) ([]ActivityItem, error)

    // Full conversation (for PC Box preview, search indexing)
    Messages() ([]TranscriptMessage, error)
}

type TranscriptMessage struct {
    Role      string    // "user", "assistant", "system", "tool_result"
    Content   string    // text content (thinking stripped)
    Timestamp time.Time
    ToolName  string    // for tool_use/tool_result messages
    Tokens    int       // token count if available
}
```

### Format Details Per Backend

| Backend | Format | Location | Resume Support |
|---------|--------|----------|----------------|
| Claude Code | JSONL | `~/.claude/projects/{hash}/{id}.jsonl` | Yes (by session ID) |
| Codex | SQLite | `~/.codex/sessions/` (configurable via CODEX_SQLITE_HOME) | Yes (`codex resume`) |
| Gemini | JSON | `~/.gemini/tmp/{hash}/chats/` | Yes (`gemini --resume`) |
| Amazon Q | Unknown | Per-directory | Yes (`q chat --resume`) |
| Aider | Markdown | `.aider.chat.history.md` | Partial (`--restore-chat-history`) |
| OpenCode | JSON | Exportable (`opencode export`) | Yes (`opencode run -c`) |
| Direct API | In-memory | Application manages | Application manages |

---

## Terminal Backend Interface

Already partially exists as `TerminalIntegration`. Expanded:

```go
type TerminalBackend interface {
    Name() string                        // "iterm2", "tmux", "kitty", etc.
    IsAvailable() bool
    Capabilities() TerminalCapabilities

    // Session lifecycle
    CreateSession(cfg TerminalConfig) (TerminalSession, error)
    FocusSession(session TerminalSession) error
    CloseSession(session TerminalSession) error

    // Communication
    WriteText(session TerminalSession, text string) error
    WriteCommand(session TerminalSession, cmd string) error  // with Enter

    // Visual
    SetTabName(session TerminalSession, name string) error
    SetTabColor(session TerminalSession, r, g, b int) error
    SetIcon(session TerminalSession, iconPath string) error

    // Status
    IsSessionFocused(session TerminalSession) bool
    GetCWD(session TerminalSession) (string, error)
}

type TerminalCapabilities struct {
    SupportsTabs       bool
    SupportsSplitPanes bool
    SupportsTabColor   bool
    SupportsIcons      bool
    SupportsProfiles   bool  // named configs (iTerm2 profiles, tmux configs)
    IsRemoteable       bool  // can be used over SSH
    IsHeadless         bool  // no GUI needed
}

type TerminalSession struct {
    ID       string  // backend-specific session ID
    TTY      string  // terminal device path
    PID      int     // shell process ID
}

type TerminalConfig struct {
    Name     string  // display name for tab
    Profile  string  // terminal profile to use (if supported)
    CWD      string  // initial working directory
    Command  string  // command to run after creation
}
```

### Implementation Notes Per Terminal

| Terminal | Platform | Automation | Session Mgmt | Tab Color | Icons | Scripting |
|----------|----------|-----------|--------------|-----------|-------|-----------|
| iTerm2 | macOS | AppleScript + Python API | UUID per session | Yes (escape seq) | Dynamic Profiles | Rich |
| tmux | macOS/Linux/WSL | CLI commands (`tmux send-keys`) | Named sessions | No (needs terminal) | No | Bash/Python (libtmux) |
| Kitty | macOS/Linux | JSON protocol (`kitten @`) | Window/tab IDs | `set-tab-color` | No | JSON commands |
| WezTerm | Cross-platform | Lua API | Workspaces | Yes | No | Lua |
| Ghostty | macOS (mainly) | AppleScript | Terminal IDs + CWD matching | Planned | Planned | AppleScript |
| Terminal.app | macOS | Limited AppleScript | Window IDs | No | No | Minimal |
| Windows Terminal | Windows | PowerShell/wt.exe args | Profile-based | Profile-based | No | Limited |
| Headless | Any | N/A | PID tracking | N/A | N/A | N/A |
| Konsole | Linux (KDE) | D-Bus | Session IDs | Tab colors via D-Bus | No | D-Bus |

### Cross-Platform Strategy

**Tier 1 (full support):** iTerm2 (macOS), tmux (everywhere)
**Tier 2 (community):** Kitty, WezTerm, Ghostty
**Tier 3 (minimal):** Terminal.app, Windows Terminal, GNOME Terminal, Konsole
**Always available:** Headless (no terminal)

tmux is the universal fallback. If a platform has tmux, pokegent works.

---

## Pokegent Core (Zero Coupling)

The core manages everything that is NOT backend-specific:

```go
type PokegentCore struct {
    agentBackend    AgentBackend
    terminalBackend TerminalBackend
    store           *Store           // running files, status, messages, etc.
    eventBus        *EventBus        // SSE to dashboard
    searchIndex     *SearchService   // PC Box
    dashboard       *DashboardServer // web UI
}
```

### What Core Owns

| System | Keyed By | Backend-Agnostic? |
|--------|----------|-------------------|
| Agent identity | pokegent_id | Yes |
| Running files | pokegent_id | Yes |
| Status files | pokegent_id | Yes |
| Sprites | pokegent_id | Yes |
| Task groups | pokegent_id | Yes |
| Grid layout | pokegent_id | Yes |
| Message mailboxes | pokegent_id | Yes |
| Agent order | pokegent_id | Yes |
| Session history (PC Box) | pokegent_id + backend_session_id | Mostly (transcript format varies) |
| Activity feed | pokegent_id | Yes (events are generic) |
| Dashboard UI | pokegent_id | Yes |
| MCP messaging | pokegent_id | Yes |

### What Core Delegates

| Operation | Delegated To | Why |
|-----------|-------------|-----|
| Launch agent | AgentBackend.Launch() | CLI/API varies |
| Resume agent | AgentBackend.Resume() | Session format varies |
| Read transcript | TranscriptReader | Format varies |
| Check liveness | AgentBackend.IsAlive() | Process model varies |
| Create terminal tab | TerminalBackend.CreateSession() | Terminal varies |
| Set tab icon | TerminalBackend.SetIcon() | API varies |
| Register hooks | AgentBackend.RegisterHooks() | Settings format varies |

---

## Hook System Design

### The Adapter Pattern

Each backend provides a hook adapter that translates native events to generic pokegent events:

```go
type HookAdapter interface {
    // Install hooks into the backend's configuration
    Install(hookPaths HookPaths) error

    // Uninstall hooks
    Uninstall() error

    // Parse native hook input into generic event
    ParseEvent(input []byte) (*AgentEvent, error)
}

// Claude Code adapter
type ClaudeHookAdapter struct{}
func (a *ClaudeHookAdapter) ParseEvent(input []byte) (*AgentEvent, error) {
    var raw struct {
        SessionID     string `json:"session_id"`
        HookEventName string `json:"hook_event_name"`
        ToolName      string `json:"tool_name"`
        // ... Claude-specific fields
    }
    json.Unmarshal(input, &raw)

    return &AgentEvent{
        EventType: mapClaudeEvent(raw.HookEventName),
        // ... translate fields
    }, nil
}

func mapClaudeEvent(name string) EventType {
    switch name {
    case "SessionStart":       return EventSessionStart
    case "Stop":               return EventTurnEnd
    case "UserPromptSubmit":   return EventTurnStart
    case "PreToolUse":         return EventToolStart
    case "PostToolUse":        return EventToolEnd
    case "PermissionRequest":  return EventPermissionNeeded
    case "SubagentStart":      return EventSubagentStart
    case "SubagentStop":       return EventSubagentEnd
    default:                   return EventIdle
    }
}
```

### Hook Script vs In-Process

Currently hooks are shell scripts invoked by Claude Code. For backends without hook support, or for the direct API backend, events can be generated in-process:

| Backend | Hook Mechanism | Where Events Originate |
|---------|---------------|----------------------|
| Claude Code | Shell scripts (registered in settings.json) | Claude CLI invokes hook scripts |
| Codex | Shell scripts (hooks.json) | Codex CLI invokes hook scripts |
| Gemini | Shell scripts (settings.json) | Gemini CLI invokes hook scripts |
| Amazon Q | JSON hooks (agent config) | Q CLI invokes hooks |
| Aider | None | Polling adapter in pokegent daemon |
| Direct API | None | In-process Go callbacks |

For shell-hook backends, the hook script is a thin shim:
```bash
#!/bin/bash
# Generic pokegent hook shim -- translates backend events to pokegent events
INPUT=$(cat)
POKEGENT_EVENT=$(echo "$INPUT" | pokegent-event-adapter "$POKEGENT_BACKEND")
echo "$POKEGENT_EVENT" | pokegent-status-update
```

For backends that support hooks but with different JSON schemas, the adapter handles translation. The core status-update logic is backend-agnostic.

---

## Configuration

```json
{
  "port": 7834,
  "agent_backend": "claude-code",
  "terminal_backend": "iterm2",

  "backends": {
    "claude-code": {
      "cli": "claude",
      "settings_path": "~/.claude/settings.json",
      "sessions_path": "~/.claude/sessions",
      "projects_path": "~/.claude/projects"
    },
    "codex": {
      "cli": "codex",
      "settings_path": "~/.codex/hooks.json",
      "sessions_path": "~/.codex/sessions"
    },
    "gemini": {
      "cli": "gemini",
      "settings_path": "~/.gemini/settings.json"
    },
    "api": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "api_key_env": "ANTHROPIC_API_KEY"
    }
  },

  "terminals": {
    "iterm2": {
      "restore_profile": "Default"
    },
    "tmux": {
      "socket": "pokegent"
    },
    "kitty": {
      "listen_on": "unix:/tmp/pokegent-kitty"
    }
  }
}
```

---

## Live Backend Switching

Users should be able to switch backends without losing their agents. Use case: ran out of Claude tokens, switch to Codex or Gemini mid-session. The pokegent identity (sprite, name, task group, grid position, message history) persists. Only the AI conversation resets.

### What Survives a Switch

Everything keyed by `pokegent_id` survives automatically:
- Sprite, display name, task group
- Grid position, agent order
- Message mailbox (inter-agent messages)
- Dashboard card state (collapsed, expanded, etc.)
- Session history in PC Box (previous sessions still browsable)

### What Doesn't Survive (Requires Migration)

The AI conversation context is backend-specific:
- Claude's JSONL transcript is not readable by Codex
- Token counts and context window differ per model
- Tool execution state (in-progress file edits, git state) is in the working directory, not the transcript

### Switch Flow

```
User: pokegent switch <pokegent_id> --backend codex

1. pokegent reads agent's running file (pokegent_id, CWD, role, project, etc.)
2. Extracts conversation summary from current backend:
   - Last N user prompts + assistant responses
   - List of files modified
   - Current task description
3. Shuts down current backend session (sends /exit to Claude)
4. Launches new backend session in same terminal tab:
   - pokegent <role>@<project> --pokegent-id <id> --backend codex
5. Injects conversation summary as system context:
   - "You are continuing work started by another agent. Here's the context: ..."
   - Includes: last task, modified files, key decisions made
6. Running file updated: backend field changes, claude_session_id cleared,
   codex_session_id set after new session starts
7. Dashboard shows same agent card (same pokegent_id), just different backend badge
```

### Context Migration Interface

```go
type ContextMigration struct {
    Summary       string            // natural language summary of conversation
    LastPrompts   []string          // last N user prompts (raw text)
    ModifiedFiles []string          // files changed in this session
    TaskContext   string            // what the agent was working on
    SystemPrompt  string            // role/project system prompt (backend-agnostic)
    CWD           string            // working directory
}

type AgentBackend interface {
    // ... existing methods ...

    // Context export for backend switching
    ExportContext(handle AgentHandle) (*ContextMigration, error)

    // Context import when starting from another backend's state
    ImportContext(cfg LaunchConfig, ctx *ContextMigration) (AgentHandle, error)
}
```

For Claude Code, `ExportContext` reads the JSONL transcript and extracts a summary. For Codex, it reads the SQLite database. For the API backend, it reads from memory.

`ImportContext` prepends the migration context to the system prompt or first user message, depending on the backend's capabilities.

### Per-Agent Backend Override

The default backend is set in config, but individual agents can use different backends:

```json
// Running file
{
  "pokegent_id": "abc-123",
  "backend": "codex",
  "claude_session_id": "",
  "codex_session_id": "xyz-789"
}
```

The dashboard shows a backend indicator on each agent card. Mixed backends in the same dashboard work because the core (messaging, grid, sprites) is backend-agnostic.

### Terminal Switching

Same pattern. If a user switches from iTerm2 to tmux:

```
pokegent terminal switch tmux
```

1. All agents' terminal sessions are recreated in tmux
2. pokegent_id, sprite, agent state all preserved
3. Running files updated with new terminal session IDs
4. Agents that were busy continue in their new terminal panes

This is simpler than backend switching because the terminal is stateless from the agent's perspective. The agent process keeps running; only the terminal wrapper changes.

### Config: Default and Per-Agent

```json
{
  "agent_backend": "claude-code",
  "terminal_backend": "iterm2",
  
  "agent_overrides": {
    "abc-123": { "backend": "codex" },
    "def-456": { "backend": "api" }
  }
}
```

---

## Migration Path

### Phase 0: pokegent_id refactor (in progress)
Stable internal ID system. Prerequisite for everything.

### Phase 1: Interface extraction (implement only, no new backends)
Define Go interfaces. Wrap current Claude Code + iTerm2 behind them. Ship. Everything still works exactly as before.

### Phase 2: tmux backend
Second terminal backend. Proves the terminal interface works. Enables Linux and WSL support.

### Phase 3: Generic hook adapter
Thin shim that translates backend-specific hook events to generic events. Claude Code adapter is first (current hook logic refactored into it). Makes it possible for community to add backends.

### Phase 4+: Community backends
With interfaces defined and two reference implementations (Claude Code + tmux), community can add:
- Codex adapter (hooks exist, similar to Claude)
- Gemini adapter (hooks exist, 10 events)
- Kitty terminal (JSON protocol, well-documented)
- Headless/API backend (for CI, daemons)

---

## Appendix A: Backend Implementation Details

### A.1 Codex CLI Backend

**Hook integration:** 5 events (SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop). JSON on stdin, similar schema to Claude. Hooks disabled on Windows.

**Session resume:** `codex resume <SESSION_ID>` or `codex resume --last`. Fork via `codex fork`.

**MCP:** Full support via `config.toml` with `[mcp_servers]` tables.

**Transcript:** SQLite database at `~/.codex/sessions/`. Query with standard SQL.

**Polling fallback:** For Windows (hooks disabled), poll process status + read SQLite every 2s.

**Key differences from Claude:**
- Hook events only fire for Bash tool (not all tools)
- No PermissionRequest, SubagentStart/Stop events
- No `idle_prompt` notification
- Transcript is SQLite, not JSONL
- `--ephemeral` mode has no session persistence

### A.2 Gemini CLI Backend

**Hook integration:** 10 events (most comprehensive). BeforeAgent/AfterAgent, BeforeModel/AfterModel, BeforeTool/AfterTool, BeforeToolSelection, PreCompress, Notification, SessionStart/End. Hooks run synchronously. Must output JSON to stdout (no plain text).

**Session resume:** `gemini --resume <UUID>` or interactive picker.

**MCP:** Full support via `settings.json`.

**Transcript:** JSON files in `~/.gemini/tmp/{project_hash}/chats/`. Includes token usage stats.

**Key differences from Claude:**
- Hooks must output JSON (not just side effects)
- BeforeModel/AfterModel events (pre/post API call) not available in Claude
- Session retention policies (maxAge, maxCount) built in
- Environment provides `GEMINI_SESSION_ID`, `GEMINI_PROJECT_DIR`

### A.3 Amazon Q Backend

**Hook integration:** 5+ events via JSON agent config (agentSpawn, userPromptSubmit, preToolUse, postToolUse, stop). Known bug: agentSpawn may fire for all prompts.

**Session resume:** `q chat --resume` (per-directory).

**MCP:** Full support via `mcpServers` in agent config with OAuth.

**Key differences from Claude:**
- Agent config is JSON files (not CLI flags)
- Custom agents are first-class (tool allowlists, aliases)
- AWS-centric (Bedrock integration)

### A.4 Direct API Backend (Anthropic Agent SDK)

**No CLI, no terminal.** Runs in the pokegent server process.

**Session management:** Agent SDK v2 has `createSession()` / `resumeSession()` with session IDs.

**Hook system:** SDK provides 17 typed hook events as TypeScript callbacks (more than any CLI). Directly maps to pokegent's generic events without shell scripts.

**MCP:** Supported natively in SDK.

**Tool execution:** Programmatic. No shell subprocess for tools. Tools are TypeScript/Python functions.

**Key differences:**
- No terminal tab, no TTY, no PID
- Events via in-process callbacks (not shell hooks)
- Transcript in memory (no JSONL files)
- Streaming via async iterators
- Can run multiple agents in a single process

### A.5 Aider Backend

**No hooks.** Must use polling.

**Session management:** File-based (`.aider.chat.history.md`). No session ID system. No resume across runs (only `--restore-chat-history`).

**MCP:** Not supported natively.

**Polling strategy:** Check if aider process is running. Read `.aider.chat.history.md` for new entries. Detect tool usage by parsing markdown output.

**Key limitations:**
- Hardest backend to integrate (no hooks, no session IDs, no MCP)
- Markdown transcript requires fragile parsing
- No way to detect tool execution programmatically
- Best suited for simple single-agent use, not orchestration

### A.6 OpenCode Backend

**Headless server mode:** `opencode serve` with mDNS discovery. API-based interaction.

**Session management:** `opencode run -c` for resume, `-s <ID>` for specific session, `--fork` for branching.

**MCP:** Full support via `opencode mcp` commands.

**Key advantage:** Built-in headless API server makes it ideal for the "no terminal" mode. Go-based, 75+ model support.

---

## Appendix B: Terminal Implementation Details

### B.1 tmux Backend

```go
type TmuxBackend struct {
    socket string  // tmux socket name for pokegent sessions
}

func (t *TmuxBackend) CreateSession(cfg TerminalConfig) (TerminalSession, error) {
    // tmux new-session -d -s <name> -c <cwd>
    // tmux send-keys -t <name> <command> Enter
}

func (t *TmuxBackend) FocusSession(s TerminalSession) error {
    // tmux select-window -t <session>:<window>
    // tmux select-pane -t <session>:<window>.<pane>
}

func (t *TmuxBackend) WriteText(s TerminalSession, text string) error {
    // tmux send-keys -t <target> <text> Enter
}
```

**Advantages:** Cross-platform, headless-capable, SSH-compatible, battle-tested.
**Limitations:** No tab colors (depends on outer terminal), no icons, no profiles.

### B.2 Kitty Backend

```go
type KittyBackend struct {
    listenOn string  // unix socket or TCP
}

func (k *KittyBackend) CreateSession(cfg TerminalConfig) (TerminalSession, error) {
    // kitten @ launch --type=tab --tab-title=<name> --cwd=<cwd>
}

func (k *KittyBackend) SetTabColor(s TerminalSession, r, g, b int) error {
    // kitten @ set-tab-color --match id:<id> active_bg=#RRGGBB
}
```

**Advantages:** Rich JSON protocol, cross-platform (macOS/Linux), tab colors, fine-grained matching.
**Limitations:** No Windows, no icons, requires `allow_remote_control` in config.

### B.3 Headless Backend

```go
type HeadlessBackend struct{}

func (h *HeadlessBackend) CreateSession(cfg TerminalConfig) (TerminalSession, error) {
    // Just exec the command as a background process
    cmd := exec.Command("sh", "-c", cfg.Command)
    cmd.Dir = cfg.CWD
    cmd.Start()
    return TerminalSession{PID: cmd.Process.Pid}, nil
}

// All visual methods are no-ops
func (h *HeadlessBackend) SetTabName(s TerminalSession, name string) error { return nil }
func (h *HeadlessBackend) SetTabColor(s TerminalSession, r, g, b int) error { return nil }
func (h *HeadlessBackend) SetIcon(s TerminalSession, path string) error { return nil }
```

---

## Appendix C: Cross-Platform Considerations

### Process Management

| Concern | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Signal handling | POSIX signals (SIGTERM, SIGHUP, etc.) | Same as macOS | Job Objects, no SIGHUP |
| PID tracking | `ps`, `kill -0` | `/proc/<pid>/`, `kill -0` | `Get-Process`, WMI |
| File watching | FSEvents (fsnotify) | inotify (fsnotify) | ReadDirectoryChangesW (fsnotify) |
| Shell | zsh (default) | bash (default) | PowerShell (default) |
| Path separator | `/` | `/` | `\` (but `/` works in most contexts) |
| Temp directory | `$TMPDIR` | `/tmp` | `%TEMP%` |
| Home directory | `$HOME` | `$HOME` | `%USERPROFILE%` |
| Socket paths | Unix domain sockets | Unix domain sockets | Named pipes (or TCP) |

### Shell Portability

pokegent.sh is currently zsh-only (macOS default). For cross-platform:

**Option A:** Rewrite pokegent.sh in POSIX sh (broad compat, loses zsh features)
**Option B:** Keep zsh for macOS, provide bash equivalent for Linux
**Option C:** Rewrite launcher in Go (compiled binary, no shell dependency)
**Option D:** Keep zsh as default, document bash/PowerShell alternatives

**Recommendation:** Option C long-term (Go binary for launcher), Option D short-term (zsh with documentation).

### Hook Script Portability

Current hooks use bash. For cross-platform:
- Hooks should remain bash (available on macOS, Linux, WSL)
- Windows native: implement hooks in Go or Node.js (hooks.json can point to `.js` or `.exe`)
- Or: implement the core hook logic in Go (compiled into the dashboard binary) and use shell scripts only as thin shims

### fsnotify

Already used in the dashboard server. Works cross-platform:
- macOS: FSEvents (efficient, directory-level)
- Linux: inotify (efficient, file-level, has queue overflow)
- Windows: ReadDirectoryChangesW (works but event batching differs)

No changes needed for cross-platform file watching.

---

## Appendix D: Open Questions

1. **Should pokegent support multiple agent backends simultaneously?** E.g., some agents on Claude Code, others on Codex. The core supports this (pokegent_id is backend-agnostic), but messaging between different backends needs thought.

2. **Should the launcher be a compiled binary or a shell script?** Shell is flexible but platform-dependent. Go binary is portable but harder to modify. Could do both: Go binary for core, shell wrapper for convenience.

3. **How should API keys be managed per backend?** Each backend has its own auth. Config file references env vars (`api_key_env`), never stores keys directly.

4. **Should headless agents appear in iTerm2?** They could be shown in the dashboard only (no terminal tab). The dashboard already handles this for ephemeral subagents.

5. **How does the PC Box work across backends?** Session history needs the backend-specific session reference to resume. Store `{pokegent_id, backend, backend_session_ref}` in the search index so resume knows which backend to use.

6. **MCP server coordination across backends?** The MCP messaging server is pokegent-level (not backend-level). Messages route by pokegent_id regardless of backend. The `spawn_agent` tool would need a `backend` parameter.
