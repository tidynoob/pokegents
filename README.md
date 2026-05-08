# Pokegents

Pokegents is a local, Pokémon-inspired dashboard that turns Claude Code and Codex sessions into a local team dashboard, where agents have persistent names, roles, chat history, status, messaging, and reusable context.

![Pokegents dashboard with agent cards, town map, and chat panel](docs/images/dashboard.png)

## What Pokegents offers

Pokegents is built around one core workflow: **make it easy to manage many agent sessions without losing track of who is doing what.**

- **Multi-session dashboard** — see active agents, status, recent output, files/commands, and conversation history in one place.
- **Projects + roles** — define reusable workspaces and reusable agent personas, then launch agents into combinations like `reviewer@backend` or `implementer@client`.
- **Claude + Codex support** — launch agents through Claude-backed or Codex-backed ACP runtimes, with configurable model choices per backend. Bring your own API keys and endpoints.
- **Agent-to-agent communication** — agents can message each other through an MCP messaging server instead of relying on copy/paste coordination.
- **Session history and resume** — browse, search, and resume any previous session from the PC Box.
- **Notifications** — get notified when an agent finishes, needs input, or changes state.
- **Two interfaces** — browser-based chat (default) with full streaming, or terminal-backed Claude Code in iTerm2 with tab colors and focus management. Switch between them on any running agent.

![Pokegents dashboard alongside an iTerm2 terminal session](docs/images/dashboard-iterm2.png)

## Install

Requirements:

- macOS or Linux
- `python3`
- At least one authenticated agent CLI/provider:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) for Claude-backed agents
  - [Codex CLI](https://github.com/openai/codex) for Codex-backed agents
- For source builds: Go 1.22+, Node.js 18+, and npm
- Optional: iTerm2 on macOS for terminal-backed Claude Code sessions

Install from source:

```bash
git clone https://github.com/tRidha/pokegents.git ~/Projects/pokegents
cd ~/Projects/pokegents
POKEGENTS_DEV_BUILD=1 ./install.sh
```

Start the dashboard:

```bash
pokegents dashboard start
pokegents dashboard open
```

The first-run onboarding flow will guide you through configuring your agent backends, creating your first project, and launching an agent.

## Quick start

1. **Start the dashboard** — `pokegents dashboard start && pokegents dashboard open`
2. **Complete onboarding** — set up at least one backend (Claude or Codex) with valid credentials.
3. **Create a project** — point it at your codebase's working directory.
4. **Launch an agent** — click "New Agent", pick a role + project + backend, and start chatting.

<p align="center"><img src="docs/images/new-agent-modal.png" width="180" alt="New agent modal with name, sprite, role, project, and backend selectors" /></p>

You can also launch from the CLI:

```bash
pokegents implementer@my-project
pokegents reviewer@my-project --backend codex
```

## Configuration

Most setup happens through the dashboard Settings UI. The important things to configure are projects, roles, and agent backends.

### Projects and roles

A **project** describes where an agent works: the working directory, project-specific context, optional extra directories, and display metadata.

A **role** describes how an agent should behave: implementer, reviewer, researcher, PM, or any custom persona you add.

Edit from the dashboard, or directly in:

```text
~/.pokegents/projects/*.json
~/.pokegents/roles/*.json
```

Example project:

```json
{
  "title": "My Project",
  "color": [100, 180, 255],
  "cwd": "~/Projects/my-project",
  "add_dirs": [],
  "context_prompt": "Project-specific context for agents working here."
}
```

Example role:

```json
{
  "title": "Reviewer",
  "emoji": "👀",
  "system_prompt": "Review changes for correctness, edge cases, and consistency.",
  "skip_permissions": null
}
```

### Agent backends

Pokegents treats **Claude** and **Codex** as provider backends. Specific models live under each backend. Each model can optionally have its own API key and endpoint, so you can use different deployments for different models.

Backend config lives at `~/.pokegents/backends.json`:

```json
{
  "version": 2,
  "backends": {
    "claude": {
      "name": "Claude",
      "type": "claude-acp",
      "default": true,
      "default_model": "sonnet-4-6",
      "models": {
        "sonnet-4-6": { "name": "Sonnet 4.6", "model": "claude-sonnet-4-6" },
        "opus-4-7": { "name": "Opus 4.7", "model": "claude-opus-4-7" }
      }
    },
    "codex": {
      "name": "Codex",
      "type": "codex-acp",
      "default_model": "gpt-5.5",
      "models": {
        "gpt-5.5": { "name": "GPT 5.5", "model": "gpt-5.5" },
        "gpt-4o": {
          "name": "GPT-4o",
          "model": "gpt-4o",
          "env": { "OPENAI_API_KEY": "sk-...", "OPENAI_BASE_URL": "https://..." }
        }
      },
      "env": {
        "CODEX_HOME": "/path/to/codex/sessions"
      }
    }
  }
}
```

Backend-level `env` applies to all models. Per-model `env` overrides let you point different models at different endpoints or API keys.

### Switching runtime on a running agent

Right-click any agent card and choose **Switch runtime** to change the interface (chat vs terminal), backend (Claude vs Codex), or model — without losing conversation history. The agent restarts with the new configuration.

## Dashboard features

### Agent cards and chat

Each agent gets a card showing its name, role, project, status, model, context usage, and recent output. Click a card to open the full chat panel with streaming conversation, tool calls, diffs, and inline permission prompts.

<p><img src="docs/images/full-chat-panel.png" width="50%" alt="Full chat panel with streaming conversation and tool calls" /></p>

### Agent-to-agent messaging

Agents coordinate via an MCP messaging server. One agent can send results to another, request a review, or ask for help — without you manually relaying messages.

<p><img src="docs/images/messaging-small.gif" width="50%" alt="Pokegents message animation between agents" /></p>

### PC Box

Browse all historical sessions — active and inactive. Search by name, role, project, or content. Resume any previous session with full conversation history.

<p><img src="docs/images/pc-box.png" width="50%" alt="PC Box session browser showing previous agents with sprites and session details" /></p>

### Other features

- **Town view** — a pixel-art map where agent sprites walk around, glow with status colors, and animate message deliveries.

<p><img src="docs/images/timeline.gif" width="30%" alt="Town timeline showing agent activity" /></p>

- **Task groups** — organize agents by workstream (e.g. "auth-migration", "proxy"). Groups are collapsible and can be released together.
- **Files and commands** — track every file an agent touched and every command it ran, searchable and copyable.

<p>
<img src="docs/images/qol-files.png" width="48%" alt="Files tab showing modified files" />
<img src="docs/images/qol-commands.png" width="48%" alt="Commands tab showing executed commands" />
</p>

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
└───────────────┬───────────────────────────────────────────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
┌────────────────┐ ┌─────────────────────────┐
│  Local state   │ │    Agent backends        │
│  ~/.pokegents  │ │  Claude ACP / Codex ACP  │
└────────────────┘ └─────────────────────────┘
```

Pokegents is local-first. The dashboard server binds to `127.0.0.1` by default — do not expose it to the public internet.

## Repository notes

- User data lives in `~/.pokegents`, not in this repository.
- Local env files such as `.env.test` are ignored.
- Runtime/generated sprite assets are not committed; source builds fetch them with `scripts/fetch-pokesprite-assets.sh`.
- Pokegents is unofficial and is not affiliated with, endorsed by, or sponsored by Nintendo, Creatures Inc., GAME FREAK Inc., The Pokémon Company, Anthropic, or OpenAI.

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
