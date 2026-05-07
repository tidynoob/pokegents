# Pokegents Architecture

Pokegents is composed of:

- `pokegent.sh`: CLI entrypoint for launching/resuming project + role sessions.
- `dashboard/server`: Go local HTTP server for state, setup, search, launch, and chat APIs.
- `dashboard/web`: React/Vite dashboard UI.
- `hooks`: Claude Code hook scripts that write local status/activity files.
- `mcp`: MCP messaging server for agent-to-agent coordination.

User data lives in `~/.pokegents` by default. The server binds to `127.0.0.1` unless explicitly configured otherwise.
