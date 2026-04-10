# pokegent_id Refactor — Implementation Plan

## Overview

Introduce `pokegent_id` as the single stable internal ID for all pokegent operations. Claude's session ID and iTerm2's session ID become downstream mappings stored in the running file but never used as keys.

---

## Phase 1: Additive (no breaking changes)

Add `pokegent_id` field everywhere without changing any existing behavior. Old agents without `pokegent_id` continue working via fallback to `ccd_session_id`.

### Changes

**1. `pokegent.sh` (zsh)**
- Generate `pokegent_id` field. For fresh launches, reuse the same UUID as `session_id` and `ccd_session_id` (simplest, same as current `ccd_session_id` behavior). For resume/fork, always generate fresh UUID via `uuidgen`.
- Write `pokegent_id` to both running file locations (new launch at line ~770, resume/fork at line ~877).
- Pass `POKEGENT_ID` env var alongside existing `POKEGENTS_SESSION_ID` in the claude launch line (~line 956).
- Parse `--pokegent-id <id>` flag (for role/project change identity preservation). If provided, use it instead of generating fresh.

**2. `dashboard/server/core/types.go`**
- Add `PokegentID string \`json:"pokegent_id,omitempty"\`` to `RunningSession` struct (after `CCDSessionID`).
- Add `GetPokegentID() string` to the Agent interface methods.

**3. `dashboard/server/models.go`**
- Add `PokegentID string \`json:"pokegent_id,omitempty"\`` to `AgentState` struct (after `CCDSessionID`).

**4. `dashboard/server/state.go`**
- In `rebuildAgents()`: Set `a.PokegentID` from `rs.PokegentID`, falling back to `rs.CCDSessionID`.
- In `GetAgent()`: Also check by `PokegentID`.
- In `sessionIDMap` building: Also map `pokegent_id` -> Claude session ID.

**5. `dashboard/web/src/types.ts`**
- Add `pokegent_id?: string` to `AgentState` interface.

**6. Frontend (`App.tsx`)**
- Update `getSpriteForId` to also key by `pokegent_id`.
- No other changes needed yet — `session_id` still works as the primary key.

### Testing Phase 1
```bash
# Shell syntax
zsh -n pokegent.sh

# Go build
cd dashboard/server && go build -o /dev/null .

# Frontend build
cd dashboard/web && npm run build
```

### Backward Compatibility
- All reads fall back: `pokegent_id || ccd_session_id || session_id`
- No file renames, no key changes
- Old running files without `pokegent_id` are silently handled

---

## Phase 2: Key internal systems by pokegent_id

Switch file naming and internal maps to use `pokegent_id` as the key. This is the core migration.

### Changes

**7. `pokegent.sh` — Running filename**
- Change `running_file="$RUNNING_DIR/${profile_name}-${session_id}.json"` to `running_file="$RUNNING_DIR/${profile_name}-${pokegent_id}.json"`
- Both the initial write (~line 753) and the resume/fork rewrite (~line 864)
- Update EXIT trap cleanup path
- Update Dynamic Profile filename: `pokegents-session-${pokegent_id}.json` instead of `pokegents-session-${session_id}.json`

**8. `pokegent.sh` — Status filename**
- Change `status_file="$POKEGENTS_DATA/status/${session_id}.json"` to `status_file="$POKEGENTS_DATA/status/${pokegent_id}.json"`

**9. `hooks/status-update.sh` — Rewrite reconciliation**
- Quick reconciliation (lines 41-72): Match by `POKEGENT_ID` env var against `pokegent_id` field. On match, update `claude_session_id` field (was `session_id`). NO file rename.
- SessionStart reconciliation (lines 240-312): 1-pass matching by `POKEGENT_ID` env var against `pokegent_id` field. Update `claude_session_id` field. NO file rename. No collision guard needed.
- SessionEnd (lines 316-324): Match by pokegent_id pattern instead of session_id pattern. Status file also keyed by pokegent_id.
- Status file write: Use `POKEGENT_ID` env var as filename key (fall back to `POKEGENTS_SESSION_ID`, then `SESSION_ID`).
- Add `claude_session_id` field to running file (rename from the mutable `session_id`).

**10. `hooks/ephemeral-track.sh`**
- Use `POKEGENT_ID` env var as `parent_session_id` (fall back to `POKEGENTS_SESSION_ID`).

**11. Dashboard server — maps keyed by pokegent_id**
- `state.go`: Change `running`, `statuses`, `agents`, `contexts`, `activityFeeds`, `nameOverrides`, `sessionIDMap`, `agentOrder` to key by pokegent_id.
- `state.go` `loadRunning()`: Use `rs.PokegentID` (falling back to `rs.CCDSessionID`) as the map key.
- `state.go` `loadStatuses()`: Status files now named `{pokegent_id}.json`.
- `state.go` `rebuildAgents()`: Key agents map by pokegent_id.
- `server.go` `resolveSessionID()`: Check `pokegent_id` first, then `ccd_session_id`, then `session_id`.
- `server.go` `relaunchIfIdle()`: Pass `--pokegent-id` flag to preserve identity across role/project changes.

**12. `dashboard/server/store/filestore.go`**
- `FileRunningStore`: Methods that glob by `*-{sessionID}.json` need to also handle pokegent_id-based filenames. During transition, try pokegent_id first, fall back to session_id.
- `Create()`: Use `PokegentID` if available for filename, fall back to `SessionID`.
- `Update()`: Glob by pokegent_id first.

**13. Grid layout keyed by pokegent_id**
- `useGridEngine.ts`: No change needed (it uses opaque string IDs from `agentIds` prop).
- `App.tsx`: Pass `agent.pokegent_id || agent.ccd_session_id || agent.session_id` as grid keys instead of `agent.session_id`.

**14. MCP server (`mcp/server.js`)**
- Add `pokegent_id` to agent list output.
- `resolveAgent`: Also match against `pokegent_id`.
- `getMySessionId`: Also check `POKEGENT_ID` env var.
- File fallback: Read `pokegent_id` from running files.

### Testing Phase 2
```bash
zsh -n pokegent.sh
bash -n hooks/status-update.sh
bash -n hooks/ephemeral-track.sh
cd dashboard/server && go build -o /dev/null .
cd dashboard/web && npm run build
```

### Backward Compatibility
- Running files without `pokegent_id` fall back to `ccd_session_id`
- Status files: Old `{session_id}.json` files still read via lookup (status merge in rebuildAgents checks both)
- Hook falls back: `POKEGENT_ID` -> `POKEGENTS_SESSION_ID` -> event `session_id`
- FileRunningStore globs both patterns during transition
- Grid layout: Agent IDs checked against both `pokegent_id` and `session_id`

---

## Phase 3: Simplify

Remove legacy code paths now that all active agents use `pokegent_id`.

### Changes

**15. `hooks/status-update.sh`**
- Remove 3-pass SessionStart reconciliation (lines 240-312). Replace with single-pass POKEGENT_ID match.
- Remove quick reconciliation file rename logic (lines 41-72). Replace with field-update-only.
- Remove session_id-based glob in SessionEnd.

**16. `pokegent.sh`**
- `ccd_session_id` references renamed to `pokegent_id` where they serve the same purpose.
- `POKEGENTS_SESSION_ID` env var kept for backward compat but `POKEGENT_ID` is the primary.

**17. Dashboard server**
- `resolveSessionID`: Simplified to direct pokegent_id lookup + prefix match.
- Remove session_id-based fallback loops.
- `resolveToCCDSessionID`: Renamed/simplified since pokegent_id replaces ccd_session_id for mailbox routing.

### Testing Phase 3
Same as Phase 2.

---

## Order of Operations

1. Write implementation plan (this file)
2. Phase 1: Additive changes (commit)
3. Phase 2: Key by pokegent_id (commit)
4. Phase 3: Simplify (commit)

Each phase is independently deployable. Phase 1 can run alongside old agents. Phase 2 starts the transition. Phase 3 cleans up after all old agents have exited.

---

## What Could Go Wrong

1. **Hook crash from bad jq** — Every jq call must have `2>/dev/null || fallback`. Test with `bash -n`.
2. **Running file glob mismatch** — During transition, files may be named by either session_id or pokegent_id. All glob patterns must try both.
3. **Status file key mismatch** — Hook writes `{pokegent_id}.json` but dashboard reads by session_id. Fix: rebuildAgents merges by matching pokegent_id across both maps.
4. **Grid layout breaks** — If grid layout was saved with session_id keys and we switch to pokegent_id keys, positions are lost. Fix: migration in useGridEngine that checks both.
5. **MCP message routing** — Messages stored under `ccd_session_id` become unreachable if we switch to `pokegent_id` mailboxes. Fix: During Phase 2, keep checking both directories.
6. **Resume session ID resolution** — pokegent.sh resolves resume targets by Claude session ID (from JSONL transcripts). This must not change — we only change the *internal* ID, not the Claude CLI interface.
7. **iTerm2 Dynamic Profile stale** — If pokegent_id differs from session_id (fork/resume case), the Dynamic Profile filename changes. The EXIT trap must clean up the correct file.
8. **FileRunningStore.Update rename** — Currently renames files when session_id changes. With pokegent_id as filename key, renames should never happen. But during transition, both patterns coexist.
9. **Hook POKEGENT_ID env var missing** — Old agents launched before the upgrade won't have POKEGENT_ID set. Hook must fall back to POKEGENTS_SESSION_ID.
10. **Two agents with same pokegent_id** — Astronomically unlikely (UUID collision) but add guard: if running file already exists for a pokegent_id, abort.
