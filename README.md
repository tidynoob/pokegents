# Pokegents

Pokegents is a local dashboard for running and coordinating multiple coding-agent sessions at once.

![Pokegents Dashboard](docs/screenshot.png)

## What Pokegents offers

Pokegents is built around one core workflow: **make it easy to manage many agent sessions without losing track of who is doing what.**

- **Multi-session dashboard** — see active agents, status, recent output, files/commands, and conversation history in one place.
- **Projects + roles** — define reusable workspaces and reusable agent personas, then launch agents into combinations like `reviewer@backend` or `implementer@client`.
- **Claude + Codex support** — launch agents through Claude-backed or Codex-backed ACP runtimes, with configurable model choices per backend.
- **Agent-to-agent communication** — agents can message each other through Pokegents instead of relying on copy/paste coordination.
- **Notifications** — get notified when an agent finishes, needs input, or changes state.
- **Browser dashboard** — local web UI for chat-backed agents, session browsing, settings, and repair tools.
- **Claude Code in iTerm2** — optional terminal-backed workflow with iTerm2 tab focus, tab colors, and terminal session management.

## Current state and tech stack

Pokegents is currently a local-first developer tool. The dashboard is a browser web app for now; a packaged desktop app may come later.

High-level stack:

- **ACP-based agent backends** for Claude/Codex runtime integration.
- **Go backend** for the local dashboard server, session state, search, notifications, and REST/SSE APIs.
- **React + Vite web app** for the dashboard UI.
- **Shell hooks/shims** for Claude Code/iTerm2 integration where needed.
- **File-backed local state** under `~/.pokegents` so config and session metadata are inspectable and recoverable.

## Install

Requirements:

- macOS or Linux
- `python3`
- At least one authenticated agent CLI/provider:
  - Claude Code CLI for Claude-backed agents
  - Codex for Codex-backed agents
- For source builds: Go, Node.js, and npm
- Optional: iTerm2 on macOS for terminal-backed Claude Code sessions

Install from source:

```bash
git clone https://github.com/tRidha/pokegents.git ~/Projects/pokegents
cd ~/Projects/pokegents
POKEGENTS_DEV_BUILD=1 ./install.sh
~/.local/bin/pokegents
```

After install, open the dashboard:

```bash
~/.local/bin/pokegents dashboard start
~/.local/bin/pokegents dashboard open
```

The first-run flow will guide you through the remaining local setup.

## Usage and configuration

Most setup should happen through the dashboard settings UI. The important things to configure are projects, roles, and agent backends.

### Projects and roles

A **project** describes where an agent works: the working directory, project-specific context, optional extra directories, and display metadata.

A **role** describes how an agent should behave: implementer, reviewer, researcher, PM, or any custom persona you add.

Projects and roles can be edited from the dashboard, or directly in:

```text
~/.pokegents/projects/*.json
~/.pokegents/roles/*.json
```

Typical project config:

```json
{
  "title": "My Project",
  "color": [100, 180, 255],
  "cwd": "~/Projects/my-project",
  "add_dirs": [],
  "context_prompt": "Project-specific context for agents working here."
}
```

Typical role config:

```json
{
  "title": "Reviewer",
  "emoji": "👀",
  "system_prompt": "Review changes for correctness, edge cases, and consistency.",
  "skip_permissions": null
}
```

### Agent backends

Pokegents treats **Claude** and **Codex** as provider backends. Specific models live under each backend.

Backend config lives at:

```text
~/.pokegents/backends.json
```

Example shape:

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

Use Settings → Agent Config to open/edit this file and choose defaults. Keep provider-specific credentials in local config only.

### Dashboard workflow

Start the dashboard, then use it to:

1. Create or select a project and role.
2. Choose an interface: Pokegents chat or iTerm2.
3. Choose a backend: Claude or Codex.
4. Launch agents and monitor them from the card grid.
5. Use the PC Box to browse and resume previous sessions.
6. Use Settings for layout, appearance, backend config, keyboard shortcuts, and dev/repair tools.

You can also launch common combinations from the CLI, for example:

```bash
pokegent reviewer@my-project
pokegent implementer@my-project
```

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                              User                                    │
│                 browser dashboard / optional iTerm2                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Pokegents Web Dashboard                         │
│               React + Vite UI, local browser app                     │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ REST / SSE / WebSocket
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Pokegents Go Server                            │
│      session registry, local config, search, notifications, ACP       │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │                               │
                ▼                               ▼
┌──────────────────────────────┐   ┌───────────────────────────────────┐
│        Local state           │   │          Agent backends            │
│        ~/.pokegents          │   │   Claude ACP / Codex ACP / iTerm2  │
│ projects, roles, running,    │   │                                   │
│ backends, history, settings  │   │                                   │
└──────────────────────────────┘   └───────────────────────────────────┘
```

Pokegents is local-first. The dashboard server binds locally by default and can launch processes, edit local config, and read local session metadata, so do not expose it to the public internet.

## Agent-to-agent messaging

Pokegents includes an MCP messaging server so agents can coordinate directly.

Example flow:

```text
Agent A asks to send results to Agent B
        ↓
Agent A calls send_message(...)
        ↓
Pokegents stores and routes the message
        ↓
Agent B receives a notification or nudge to check messages
        ↓
Agent B can reply with findings, review notes, or next steps
```

This is useful for parallel work: one agent can implement, another can review, and a third can investigate without requiring you to manually relay every update.

## Repository notes

- User data lives in `~/.pokegents`, not in this repository.
- Local env files such as `.env.test` are ignored.
- Runtime/generated sprite assets are not committed; source builds fetch them with `scripts/fetch-pokesprite-assets.sh`.
- Pokegents is unofficial and is not affiliated with, endorsed by, or sponsored by Nintendo, Creatures Inc., GAME FREAK Inc., The Pokémon Company, Anthropic, or OpenAI.

## License

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
