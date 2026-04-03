# Role x Project Profile Split — Design & Migration Plan

## Problem

The current `profiles/*.json` system conflates two orthogonal concerns:

| Concern | What it controls | Examples |
|---------|-----------------|----------|
| **Project** (where) | cwd, add_dirs, codebase context, color, iTerm2 profile | client, platform, rollouts, pokegents |
| **Role** (how) | system_prompt persona, expertise, behavior, emoji | PM, dev, researcher, reviewer |

Today, "client" is a profile that bundles both the workspace (cwd to cgft/) and the persona ("You are working on the cgft client library..."). This means:
- You can't be a PM for the client project without creating a separate `client-pm` profile
- N roles x M projects = N*M profiles (combinatorial explosion)
- Clones of the same project get the same persona even when they should differ

## Solution: Two-Dimensional Composition

Split profiles into **projects** and **roles**. Launch with `pokegent role@project` syntax. Existing `profiles/` directory kept for backwards compatibility.

## New Directory Structure

```
~/.pokegents/
  projects/              # NEW — workspace config
    client.json
    platform.json
    rollouts.json
    pokegents.json
    personal.json        # default project (cwd: ~/Projects)
  roles/                 # NEW — persona config
    dev.json
    pm.json
    researcher.json
    reviewer.json
  profiles/              # KEPT — legacy combined profiles (backwards compat)
    client.json          # still works, treated as combined project+role
    personal.json
    ...
  config.json            # updated with new defaults
```

## JSON Schemas

### Project (`projects/*.json`)

Controls *where* the agent works. Provides workspace identity (color, cwd, iTerm2 theming).

```json
{
  "title": "Client SDK",
  "color": [180, 140, 255],
  "iterm2_profile": "CCD: Client SDK",
  "cwd": "~/Projects/cgft_projects/cgft",
  "add_dirs": [],
  "context_prompt": "Python 3.12, uv, ruff, mypy. Focus on data prep pipeline and training job submission."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Human-readable project name |
| `color` | [r,g,b] | yes | RGB for iTerm2 tab color and dashboard card |
| `iterm2_profile` | string | no | iTerm2 Dynamic Profile name (overrides color) |
| `cwd` | string | yes | Working directory. `~` is expanded. |
| `add_dirs` | string[] | no | Extra directories passed to `--add-dir` |
| `context_prompt` | string | no | Appended to system prompt. Describes the codebase/tech stack. |

### Role (`roles/*.json`)

Controls *how* the agent behaves. Provides persona identity (emoji, behavior).

```json
{
  "title": "PM",
  "emoji": "\ud83d\udccb",
  "system_prompt": "You are a product manager agent. Focus on requirements, priorities, and cross-team coordination. Don't write code unless asked \u2014 instead review, plan, and delegate.",
  "skip_permissions": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Human-readable role name |
| `emoji` | string | yes | Emoji for tab title and dashboard pill |
| `system_prompt` | string | yes | Role-specific behavioral instructions |
| `skip_permissions` | bool | no | Override per-role (default: inherit from config) |

### Legacy Profile (`profiles/*.json`) — unchanged

```json
{
  "title": "Client SDK",
  "emoji": "\ud83d\udce6",
  "color": [180, 140, 255],
  "iterm2_profile": "CCD: Client SDK",
  "cwd": "/path/to/project",
  "add_dirs": [],
  "system_prompt": "Combined persona + context prompt"
}
```

## Composition Rules

When launching `pokegent dev@client`:

1. Load `projects/client.json` -> workspace fields
2. Load `roles/dev.json` -> behavior fields
3. Compose:

| Field | Source | Example |
|-------|--------|---------|
| `cwd` | project | `/Users/thariq/Projects/cgft_projects/cgft` |
| `add_dirs` | project | `[]` |
| `color` | project | `[180, 140, 255]` |
| `iterm2_profile` | project | `"CCD: Client SDK"` |
| `emoji` | role | `"\ud83d\udee0\ufe0f"` |
| `system_prompt` | **project.context_prompt + role.system_prompt** | See below |
| `skip_permissions` | role (if set, non-null) > config global. Shell: `jq -r '.skip_permissions // "unset"'` to distinguish null/absent from false. | `false` |
| `display_name` | `role.emoji + " " + role.title + " \u2014 " + project.title` | `"\ud83d\udee0\ufe0f Dev \u2014 Client SDK"` |

### System Prompt Assembly Order

```
1. project.context_prompt     (codebase context — the "what")
2. "\n\n"
3. role.system_prompt          (behavioral instructions — the "how")
4. "\n\n"
5. messaging_prompt            (agent messaging boilerplate — always appended)
```

**Rationale:** Project context first, then role instructions. Claude pays more attention to instructions later in the prompt, and the role is the behavioral directive that should take priority over context.

## Launch Syntax

```bash
pokegent dev@client              # role@project composition
pokegent pm@platform             # PM persona in platform project
pokegent @client                 # project only, no role (bare — context_prompt as system_prompt)
pokegent dev@                    # role only, uses default_project from config
pokegent client                  # ambiguous — resolution below
pokegent ls                      # list everything (projects, roles, legacy)
pokegent projects                # list projects only
pokegent roles                   # list roles only
pokegent edit project client     # edit a project config
pokegent edit role dev           # edit a role config
pokegent edit client             # edit legacy profile (backwards compat)
```

## Resolution Logic

When `pokegent <arg>` is called (no `@`):

```
1. If arg contains "@":
   a. Split into role@project
   b. Empty role (e.g. "@client") → project-only, no role
   c. Empty project (e.g. "dev@") → role + default_project
   d. Both present → load both, compose

2. If arg matches a projects/ filename (without .json):
   → Launch as project-only (no role). Uses context_prompt as system_prompt.
   → If a legacy profile with the same name also exists, print:
      "Note: Using project 'client'. To use legacy profile, run: pokegent --legacy client"

3. If arg matches a profiles/ filename (legacy):
   → Launch as legacy profile (unchanged behavior)

4. If arg matches a roles/ filename:
   → Launch as role + default_project from config

5. Error: "Unknown profile, project, or role: <arg>"
```

**Priority: project > legacy profile > role** (when names collide).

The `--legacy` flag forces legacy profile resolution, bypassing project lookup.

## Running File Changes

Add `role` and `project` fields alongside existing `profile`:

```json
{
  "profile": "dev@client",
  "role": "dev",
  "project": "client",
  "session_id": "abc123...",
  "ccd_session_id": "def456...",
  "pid": 12345,
  "tty": "/dev/ttys001",
  "display_name": "\ud83d\udee0\ufe0f Dev \u2014 Client SDK",
  "iterm_session_id": "...",
  "created_at": "2026-03-31T..."
}
```

- `profile` = composite key (`role@project`, or just `project`, or legacy profile name)
- `role` = role name (empty string for bare project or legacy)
- `project` = project name (empty string for legacy profiles)

Legacy running files (no `role`/`project` fields) continue to work — dashboard treats missing fields as empty strings.

## Config Changes

```json
{
  "port": 7834,
  "default_project": "personal",
  "default_role": null,
  "default_profile": "personal",
  "skip_permissions": false,
  "iterm2_restore_profile": "Default"
}
```

- `default_project` replaces `default_profile` as the primary default
- `default_role` (null = bare project, no role)
- `default_profile` kept for backwards compat — used when `default_project` is not set

Bare `pokegent` (no args) resolves: if `default_role` is set, launches `default_role@default_project`. Otherwise launches `default_project` as bare project. If neither exists, falls back to `default_profile` (legacy).

## Dashboard Changes

### API

`GET /api/sessions` response adds fields:

```json
{
  "session_id": "...",
  "profile_name": "dev@client",
  "role": "dev",
  "project": "client",
  "role_emoji": "\ud83d\udee0\ufe0f",
  "project_color": [180, 140, 255],
  ...
}
```

`GET /api/profiles` becomes `GET /api/profiles` (legacy) + `GET /api/projects` + `GET /api/roles`.

### Frontend

- **Agent cards**: Two pills — `[role emoji + role name]` in neutral color, `[project name]` in project color. Uses existing `ProfilePill` component.
- **Grouping**: Flat grid (no grouping by default). Both pills are visually scannable. Future: optional grouping by project.
- **Launch dropdown**: Single dropdown showing `role@project` combos with recent/frequent at top. Search filters across both dimensions.
- **Session browser (PC BOX)**: Shows `"Session Name" — role@project` with both pills. Search matches either dimension.
- **Card title**: `display_name` (e.g. "Dev — Client SDK"). Emoji comes from role.

### Go Server Types

```go
// core/types.go additions
type RunningSession struct {
    Profile        string `json:"profile"`
    Role           string `json:"role,omitempty"`           // NEW
    Project        string `json:"project,omitempty"`        // NEW
    SessionID      string `json:"session_id"`
    // ... existing fields unchanged
}

type ProjectConfig struct {
    Name          string `json:"name"`
    Title         string `json:"title"`
    Color         [3]int `json:"color"`
    CWD           string `json:"cwd"`
    AddDirs       []string `json:"add_dirs,omitempty"`
    ContextPrompt string `json:"context_prompt,omitempty"`
    ITermProfile  string `json:"iterm2_profile,omitempty"`
}

type RoleConfig struct {
    Name            string `json:"name"`
    Title           string `json:"title"`
    Emoji           string `json:"emoji"`
    SystemPrompt    string `json:"system_prompt"`
    SkipPermissions *bool  `json:"skip_permissions,omitempty"`
}
```

### Search Index

Add `role` and `project` columns to `session_meta`:

```sql
ALTER TABLE session_meta ADD COLUMN role TEXT DEFAULT '';
ALTER TABLE session_meta ADD COLUMN project TEXT DEFAULT '';
```

Search matches against role and project names in addition to existing fields.

## History Tracking

**Per-project.** History files move from `history/{profile}.json` to `history/{project}.json`.

Rationale: "What happened in this codebase" is more useful than "what did this persona do." When resuming client work, you want to see all recent client sessions regardless of whether they were PM or dev.

Legacy `history/{profile}.json` files are still read (fallback) but new entries are written to `history/{project}.json`.

## Open Design Decisions

### 1. Clone naming
`{role.title} — {project.title} (clone)` — clone suffix applied to the full composite name.

### 2. Sprite assignment
Hash on `session_id` (unchanged). Sprites are per-agent identity, not per-role or per-project. Two dev@client clones get different sprites.

### 3. iTerm2 profile inheritance
Sprite Dynamic Profiles inherit from the project's `iterm2_profile`. Two agents on the same project (one PM, one dev) share the same tab color.

### 4. `pokegent ls` output format
```
Projects:
  client       Client SDK          [180, 140, 255]  /path/to/cgft
  platform     Platform            [100, 180, 255]  /path/to/expt-platform
  personal     Personal            [180, 180, 200]  ~/Projects

Roles:
  dev          \ud83d\udee0\ufe0f Developer
  pm           \ud83d\udccb PM
  researcher   \ud83e\uddea Researcher
  reviewer     \ud83d\udc40 Reviewer

Legacy profiles:
  client       \ud83d\udce6 Client SDK       (shadowed by project — use --legacy)
  personal     \ud83c\udfe0 Personal          (shadowed by project — use --legacy)
```

---

# Migration Plan

## Guiding Principle

**Zero breakage for existing agents.** Every currently-running agent must continue to work without any action. New features are strictly additive. Old formats are read indefinitely.

## Phase 0: Preparation (no behavior changes)

**Goal:** Create the new directories and types without changing any runtime behavior.

### Steps

1. **Create directory structure**
   - `install.sh` creates `~/.pokegents/projects/` and `~/.pokegents/roles/` (empty)
   - Existing `~/.pokegents/profiles/` is untouched

2. **Add Go types** (core/types.go)
   - Add `ProjectConfig`, `RoleConfig` structs
   - Add `Role`, `Project` fields to `RunningSession` with `omitempty` tags
   - Add `Role`, `Project` fields to `Profile` (or keep `Profile` for legacy and add new types)

3. **Add store interfaces** (store/store.go)
   - `ProjectStore` interface: `List() []ProjectConfig`, `Get(name) *ProjectConfig`
   - `RoleStore` interface: `List() []RoleConfig`, `Get(name) *RoleConfig`

4. **Add filestore implementations** (store/filestore.go)
   - Read from `projects/` and `roles/` directories
   - Empty directories = empty lists (not an error)

5. **Add API endpoints** (server.go)
   - `GET /api/projects` — list project configs
   - `GET /api/roles` — list role configs
   - These return empty arrays until projects/roles are created

### Validation
- `go build` passes
- All existing tests pass
- Dashboard works unchanged
- All running agents unaffected

## Phase 1: Shell support (backwards-compatible)

**Goal:** `pokegent.sh` learns `@` syntax and the resolution logic, but existing commands work identically.

### Steps

1. **Add resolution logic** to `pokegent()`
   - Parse `@` in first arg
   - Implement the 5-step resolution chain (see Resolution Logic above)
   - Load project JSON + role JSON when `@` is present
   - Compose system prompt (project context + role instructions)

2. **New running file fields**
   - Write `role` and `project` fields in running file JSON
   - Legacy launches (no `@`): `role=""`, `project=""`, `profile=<legacy_name>`
   - Composed launches: `role=<name>`, `project=<name>`, `profile=<role>@<project>`

3. **New subcommands**
   - `pokegent projects` — list `~/.pokegents/projects/*.json`
   - `pokegent roles` — list `~/.pokegents/roles/*.json`
   - `pokegent edit project <name>` / `pokegent edit role <name>`
   - `pokegent ls` updated to show all three categories

4. **Update help text** (`-h` / `--help`)

5. **Ambiguity warning**
   - When `pokegent client` matches both a project and legacy profile, print note

### Validation
- `pokegent client` still works (resolves to project or legacy — same behavior)
- `pokegent dev@client` launches with composed prompt
- `pokegent @client` launches bare project
- Running file has new fields
- Dashboard shows new agents correctly (new fields are additive, `profile_name` still populated)

## Phase 2: Dashboard support

**Goal:** Dashboard reads and displays role/project info. Frontend shows two pills.

### Steps

1. **Server: parse new running file fields**
   - `state.go` / `StateManager` reads `role` and `project` from running files
   - Falls back gracefully: missing fields = empty string
   - API response includes `role`, `project`, `role_emoji`, `project_color`

2. **Server: project/role endpoints**
   - `GET /api/projects` returns project configs (for launch picker)
   - `GET /api/roles` returns role configs (for launch picker)

3. **Frontend: agent card pills**
   - Add role pill next to existing profile pill
   - Role pill: role emoji + role title, neutral color
   - Project pill: project title, project color
   - When only legacy profile: single pill (current behavior, unchanged)

4. **Frontend: launch picker**
   - Add role@project grid/dropdown to launch modal
   - Keep legacy profile launch as fallback option

5. **Frontend: session browser**
   - Show role + project pills in session list
   - Search matches role and project names

6. **Search index migration**
   - Add `role` and `project` columns (SQLite ALTER TABLE with defaults)
   - Populate on new session indexing
   - Old sessions: empty strings (harmless)

### Validation
- Legacy agents show single pill (unchanged appearance)
- New role@project agents show two pills
- Launch picker offers both legacy and composed options
- Search works across dimensions

## Phase 3: Seed default roles and projects

**Goal:** Provide useful defaults so users can start composing immediately.

### Steps

1. **Create default project configs** from existing profiles
   - Extract workspace fields (cwd, color, add_dirs, iterm2_profile) into `projects/`
   - Extract context from system_prompt into `context_prompt`

2. **Create default role configs**
   - `dev.json` — general development (write code, fix bugs, refactor)
   - `pm.json` — product management (review, plan, delegate, don't code)
   - `researcher.json` — research and investigation (explore, analyze, summarize)
   - `reviewer.json` — code review (already exists as a legacy profile — extract)

3. **Ship in `defaults/`**
   - `defaults/projects/` and `defaults/roles/` in the repo
   - `install.sh` copies to `~/.pokegents/` if directories are empty (don't overwrite)

4. **Update config.json defaults**
   - `default_project: "personal"`
   - `default_role: null`

### Validation
- Fresh install gets working projects + roles
- Existing install is not modified (directories already have content)
- `pokegent dev@client` works out of the box after install

## Phase 4: History migration

**Goal:** Transition history tracking from per-profile to per-project.

### Steps

1. **Write path**: new history entries go to `history/{project}.json`
2. **Read path**: when loading history, check `history/{project}.json` first, fall back to `history/{profile}.json`
3. **No migration script needed** — old history files are read as-is, new entries accumulate in project files
4. Over time, project history files become authoritative as new sessions are created

## Backwards Compatibility Matrix

| Scenario | Behavior | Status |
|----------|----------|--------|
| `pokegent client` (legacy profile exists) | Launches legacy profile | **Unchanged** |
| `pokegent client` (project exists, no legacy) | Launches bare project | **New** |
| `pokegent client` (both exist) | Launches project, prints note | **New** (warning only) |
| `pokegent --legacy client` | Forces legacy profile | **New** |
| `pokegent dev@client` | Composed launch | **New** |
| Running agent with old running file (no role/project fields) | Dashboard shows as before | **Unchanged** |
| Resume old session | Works — no role/project in JSONL is fine | **Unchanged** |
| Hook processing old running file | No changes needed — hook doesn't read role/project | **Unchanged** |
| MCP messaging with old agents | Works — messaging uses session_id/ccd_session_id, not profile | **Unchanged** |
| Dashboard with mix of old and new agents | Old agents: single pill. New agents: two pills. | **Graceful** |
| `pokegent ls` | Shows all three categories | **Enhanced** |
| `config.json` without new fields | Falls back to `default_profile` | **Unchanged** |

## Risk Mitigation

1. **Rollback**: If anything breaks, delete `projects/` and `roles/` directories. Everything falls back to legacy `profiles/`. The `@` syntax simply won't find any projects/roles and will error clearly.

2. **No file format changes to existing files**: `profiles/*.json`, `running/*.json`, `status/*.json`, `config.json` all gain new optional fields but no required field changes. Old files parse correctly.

3. **Hook safety**: `status-update.sh` does not need changes in Phase 0-1. It reads `profile` from running file (still populated). New fields are ignored by old hook code.

4. **Atomic rollout**: Each phase is independently deployable and reversible. Phase 1 (shell) can ship without Phase 2 (dashboard). Phase 2 can ship without Phase 3 (defaults).

## File Ownership (for multi-agent implementation)

| File | Owner | Phase |
|------|-------|-------|
| `pokegent.sh` | GOD | Phase 1 |
| `lib/helpers.sh` | GOD | Phase 1, 4 |
| `install.sh` | GOD | Phase 0, 3 |
| `defaults/projects/*.json` | GOD | Phase 3 |
| `defaults/roles/*.json` | GOD | Phase 3 |
| `core/types.go` | Refactor | Phase 0 |
| `store/store.go` | Refactor | Phase 0 |
| `store/filestore.go` | Refactor | Phase 0 |
| `server.go` (new endpoints) | Refactor | Phase 2 |
| `state.go` (parse new fields) | Refactor | Phase 2 |
| `search.go` (schema migration) | Refactor | Phase 2 |
| `dashboard/web/src/types.ts` | UI Specialist | Phase 2 |
| `dashboard/web/src/components/AgentCard.tsx` | UI Specialist | Phase 2 |
| `dashboard/web/src/components/SessionBrowser.tsx` | UI Specialist | Phase 2 |
| `dashboard/web/src/App.tsx` (launch picker) | UI Specialist | Phase 2 |
| `hooks/status-update.sh` | — | No changes needed |
| `mcp/server.js` | — | No changes needed |
