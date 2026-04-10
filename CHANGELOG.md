# Changelog

## v0.4.0 — 2026-04-09

### Sprite System Refactor (BREAKING)
- Sprites are now stored once in the running file (`"sprite": "jirachi"`) and read everywhere
- No more hash-based sprite derivation -- sprites are randomly assigned on first launch, then persistent
- Sprite picker updates running file + iTerm2 Dynamic Profile live (no reload needed)
- New Agent launcher sprite selection now persists correctly

**Migration required for existing users:**
```bash
git pull origin main
./scripts/migrate-sprites.sh    # backfills sprite field into running files + search DB
pokegent dashboard build        # rebuild and restart
```

Historical PC Box sessions without sprites will show as pokeball. Active agents will keep their current sprites.

### Other Changes
- Grid: TIDY UP and RESET buttons, ghost layout pruning, auto-compact fixes
- Groups: context menu to assign/create groups, drag-to-group, compact member rows
- Activity feed: fixed stale entries re-appearing after new prompt
- Resume: PC Box shows RESUME vs COMPACT buttons for auto-compact choice
- Hooks: SIGINT trap so Ctrl+C doesn't kill hooks mid-write
- Task grouping (PR #3), subagent tracking (PR #4), resume fixes (PR #5) from Angel

## v0.3.0 — 2026-04-03

### Grid System Redesign
- Configurable grid layout: set rows and columns in settings
- Cards default to 2x2 grid cells, resizable by dragging bottom-right handle
- Drag and drop with iOS-style animations — displaced cards smoothly slide to new positions
- Grid layout persisted to server (`~/.pokegents/grid-layout.json`), survives refresh
- Named layout profiles: save/load grid arrangements via API
- No more card overlap — collision resolution on every placement, resize, and spawn

### PC Box (Session Browser)
- Fire Red-style 6x5 sprite grid for browsing past sessions
- PKMN DATA panel with sprite, name, role/project pills
- Last prompt and last message preview (fetched from transcript, skips farewells)
- Resume sessions directly from PC Box

### Pokeball Animations
- Collapse: red recall beam at sprite position, pokeball arcs to header bar
- Expand: pokeball thrown from header, bounces, white circle morphs to card shape
- Collapsed agents shown as pokeball sprites inline with header
- Hover pokeballs to preview agent status

### Dashboard Improvements
- `pokegent dashboard build` command — builds server + frontend, restarts without touching sessions
- Header shows "X active, Y idle" with pokeballs inline
- Manual expand persists across refresh (won't auto-re-collapse)
- Fixed bottom MAIL/LOG bar pinned to viewport bottom
- Grid lines visible during drag, resize, and settings adjustment

### Fixes
- Dashboard POKEGENTS_DATA env var now passed on all launch paths (fixes fresh installs)
- Makefile binary name matches pokegent.sh expectations
- install.sh creates grid-profiles, activity directories
- Search index no longer duplicates last message tracking
- Compaction detection uses 64KB tail (was 8KB)
- Terminal scrollback preserved (printf instead of clear)

## v0.2.0 — 2026-03-31

### Fire Red Reskin
- Pokemon-themed GBA aesthetic with Fire Red color palette
- Pixel creature sprites (deterministic from session ID)
- Sprite animations: idle (blink/doze), busy (hop/shake), done (sway/celebrate)
- GBA scanline overlay, pixel font, card shine effects
- Message delivery animations (sprite flies between cards)

### Role @ Project System
- Compose roles with projects: `pokegent dev@client`
- Separate project configs (cwd, color) and role configs (emoji, system prompt)
- Settings panel with theme, font size, auto-collapse controls
- Launch modal for spawning new agents from the dashboard

## v0.1.0 — 2026-03-24

### Initial Release
- Named profiles with per-project config
- Session tracking via Claude Code hooks
- Web dashboard with live status updates via SSE
- Agent-to-agent messaging via MCP
- macOS notifications on agent completion
- iTerm2 integration (tab colors, focus, nudging)
- Full-text session search with SQLite FTS5
- Session resume from dashboard and CLI
