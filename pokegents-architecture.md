# pokegents — system architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  DASHBOARD UI  (React + Vite)                                                               │
│                                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│  │ Agent Cards  │  │  Chat Panel  │  │ Town Minimap │  │   Settings   │                     │
│  │  flow grid   │  │  ACP stream  │  │  BFS sprites │  │  per-row/col │                     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘                     │
│                                                                                             │
│  card order = drag-reorderable array, CSS grid auto-wrap                                    │
│  chat panel = SSE EventSource for ACP transcript (tool calls, markdown, images)              │
│  town = pokémon-style overworld, agents walk between painted idle/busy zones                 │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                              │ SSE (state_update, ping, new_message)
                              │ REST (/api/sessions/{id}/prompt, /cancel, /rename, …)
                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  DASHBOARD SERVER  (Go, single binary)                                                      │
│                                                                                             │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────────────────────────────────────────┐ │
│  │ SSE Event Bus │  │ State Manager  │  │              Runtime Registry                   │ │
│  │ 1024-buf/client│  │ file watcher   │  │                                                 │ │
│  │ drop-oldest   │  │ fsnotify on    │  │  ┌──────────────────┐  ┌──────────────────────┐ │ │
│  │ 10s ping      │  │ running/ +     │  │  │  iterm2 Runtime  │  │    Chat Runtime      │ │ │
│  └───────────────┘  │ status/        │  │  │  AppleScript     │  │    claude-agent-acp  │ │ │
│                     └────────────────┘  │  │  WriteText(TTY)  │  │    JSON-RPC / NDJSON │ │ │
│                                         │  └──────────────────┘  └──────────────────────┘ │ │
│  Nudger: wakes idle agents via          │     dispatches by agent.interface                │ │
│  Runtime.CheckMessages(pgid)            └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                              │ both runtimes wrap the same CLI
                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  CLAUDE CODE CLI                                                                            │
│                                                                                             │
│  claude --resume <session_id> --name <display_name> --append-system-prompt …                │
│                                                                                             │
│  identity:  pokegent_id (stable, survives resume/clone/backend-swap)                        │
│             └─ claude session_id (ephemeral, changes on fork/resume)                        │
│                                                                                             │
│  hooks:     SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop                   │
│  MCP:       list_agents · send_message · check_messages  (via MCP server)                   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
          │                          │                              │
          │ hooks fire on            │ MCP tool calls               │
          │ lifecycle events         │ between agents               │
          ▼                          ▼                              ▼
┌────────────────────┐  ┌─────────────────────────┐  ┌────────────────────────────┐
│  HOOKS             │  │  MCP MESSAGING SERVER    │  │  CLAUDE API                │
│  status-update.sh  │  │  (Node.js)               │  │  (Anthropic)               │
│                    │  │                           │  │                            │
│  writes:           │  │  tools:                   │  │  model inference           │
│  status/{id}.json  │  │  • list_agents            │  │  tool use orchestration    │
│  running/{id}.json │  │  • send_message           │  │                            │
│                    │  │  • check_messages          │  │                            │
│  chat agents skip  │  │                           │  │                            │
│  (interface gate)  │  │  budget: 15 msgs/turn     │  │                            │
│                    │  │  delivery: hook inject     │  │                            │
│  ◄── file watcher  │  │    OR agent polls         │  │                            │
│      feeds State   │  │  nudger: wakes idle agent  │  │                            │
│      Manager above │  │    via Runtime.CheckMsgs   │  │                            │
└────────────────────┘  └─────────────────────────┘  └────────────────────────────┘
          │                          │
          └──────────┬───────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  ~/.pokegents/  (all state is plain files — no database)                                    │
│                                                                                             │
│  profiles/*.json     per-profile config (cwd, system_prompt, color, iterm2_profile)         │
│  agents/*.json       stable identity (pokegent_id, role, project, sprite)                   │
│  running/*.json      active session registry (pid, tty, interface, session_id)              │
│  status/*.json       structured state (busy/idle/done, detail, last_trace, busy_since)      │
│  messages/{pgid}/    mailbox per agent (one .json per message, flag + delete lifecycle)      │
│  grid-layout.json    card order + density (cardsPerRow, cardsPerCol, gap, order[])           │
│  town-mask.json      walkable/busy/idle cell painting for the minimap                       │
│  config.json         port, default_profile, skip_permissions                                │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```
