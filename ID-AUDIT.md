# Pokegents ID System Audit & Migration Plan

## Goal

Introduce a single **pokegent_id** as the internal source of truth. Claude's session ID and iTerm2's session ID become downstream mappings. The system should be decoupled enough that pokegents can eventually work with other AI CLIs or terminals.

---

## Current ID Types

| ID | Source | Stable? | Used For |
|----|--------|---------|----------|
| `session_id` (running file) | pokegent.sh, then patched by hook to Claude's conversation ID | NO | Running file key, status file key, Dynamic Profile filename, dashboard primary key |
| `ccd_session_id` (running file) | pokegent.sh `uuidgen` | YES | Message routing, hook reconciliation anchor, env var to Claude |
| Claude conversation ID | Claude CLI | YES per conversation | JSONL transcript filename, hook event `session_id` field, `--resume` target |
| `iterm_session_id` | iTerm2 | YES per tab | Tab focus/write via AppleScript |
| `tty` | OS | YES per terminal | Fallback for session matching |
| Dynamic Profile GUID | pokegent.sh | YES but uses wrong ID | iTerm2 sprite icon (`CCD-SESSION-{initial_session_id}`) |

---

## Every Lifecycle Flow

### 1. New Agent (CLI: `pokegent <profile>`)

**Current:**
```
pokegent.sh:  session_id = UUID-A, ccd_session_id = UUID-A (same)
              writes running file: {profile}-UUID-A.json
              writes Dynamic Profile: pokegents-session-UUID-A.json
              passes --session-id UUID-A to Claude
              sets POKEGENTS_SESSION_ID = UUID-A
Claude:       uses UUID-A as conversation ID (usually)
Hook:         SessionStart with session_id=UUID-A, matches running file, no rename needed
```
**Issues:** None for new sessions. IDs match.

**With pokegent_id:** Same behavior. `pokegent_id` = UUID-A. `claude_session_id` = UUID-A (set by Claude). All files keyed by pokegent_id.

---

### 2. New Agent (Dashboard LaunchModal)

**Current:**
```
LaunchModal:  POST /api/launch -> server writes AppleScript -> "pokegent <profile>"
              Same as flow #1 from here
              After agent appears, polls and calls setSprite(session_id, sprite)
```
**Issues:** LaunchModal calls `setSprite` with the API's `session_id` (Claude's conversation ID after reconciliation). If reconciliation changed the ID, the Dynamic Profile file (named by original ID) isn't found.

**With pokegent_id:** LaunchModal calls `setSprite(pokegent_id, sprite)`. Dynamic Profile is named `pokegents-session-{pokegent_id}.json`. Always matches.

---

### 3. Clone/Fork (`--resume <id> --fork-session`)

**Current:**
```
pokegent.sh:  session_id = UUID-A (initial, for sprite + Dynamic Profile)
              ccd_session_id = UUID-C (fresh, for separate mailbox)
              writes running file: {profile}-UUID-A.json
              writes Dynamic Profile: pokegents-session-UUID-A.json
              passes --resume <original_id> --fork-session to Claude
              sets POKEGENTS_SESSION_ID = UUID-C
Claude:       assigns NEW conversation ID = UUID-D (different from UUID-A!)
Hook:         SessionStart with session_id=UUID-D
              Pass 1: matches ccd_session_id=UUID-C via POKEGENTS_SESSION_ID env
              Patches running file session_id: UUID-A -> UUID-D
              Renames file: {profile}-UUID-A.json -> {profile}-UUID-D.json
              Dynamic Profile still: pokegents-session-UUID-A.json (NOT renamed!)
```
**Issues:** 3 different UUIDs. Dynamic Profile filename stale after rename. Dashboard uses UUID-D, Dynamic Profile uses UUID-A. Sprite updates fail to find the file.

**With pokegent_id:** `pokegent_id` = UUID-C (stable, never changes). Running file: `{profile}-UUID-C.json` (never renamed). Dynamic Profile: `pokegents-session-UUID-C.json` (never renamed). Hook just updates `claude_session_id` field from UUID-A to UUID-D. No file renames.

---

### 4. Resume (CLI: `pokegent <profile> -r <id>`)

**Current:**
```
pokegent.sh:  Finds original session ID from JSONL transcripts
              session_id = original_conversation_id (reuse)
              ccd_session_id = UUID-B (fresh, for separate mailbox)
              writes running file: {profile}-{original_sid}.json
              passes --resume <original_sid> to Claude
              sets POKEGENTS_SESSION_ID = UUID-B
Claude:       resumes same conversation (same session ID)
Hook:         SessionStart with session_id=original_sid, matches running file
```
**Issues:** Fresh `ccd_session_id` means new mailbox, new identity. Old messages, sprite, task_group must be recovered separately. If original agent is still running, TWO running files exist with same `session_id` in the filename.

**With pokegent_id:** `pokegent_id` = UUID-B (fresh). Running file: `{profile}-UUID-B.json`. `claude_session_id` = original's conversation ID. No filename collision with original (different pokegent_id). Sprite inherited from original's running file or search index.

---

### 5. Resume (PC Box / Dashboard)

**Current:**
```
Dashboard:    POST /api/sessions/{id}/resume
Server:       Recovers metadata (role, project, task_group) from search index
              Composes pokegent target: role@project
              Calls terminal.ResumeSession(target, sessionID, compact)
Terminal:     AppleScript: "pokegent <target> -r <sessionID>"
              Then same as flow #4
```
**Issues:** Sprite recovery from search index added but not fully working. Task group re-assigned via `pendingResumeTaskGroups` (timing-dependent). Profile name was empty (fixed in PR #5).

**With pokegent_id:** Search index stores sprite and all metadata keyed by pokegent_id. Resume API passes pokegent_id. pokegent.sh queries `/api/sessions/{pokegent_id}/meta` for sprite, task_group. All metadata survives session death.

---

### 6. Role/Project Change (Dashboard Context Menu)

**Current:**
```
Dashboard:    POST /api/sessions/{id}/role  (or /project)
Server:       Updates running file fields (role, project, profile)
              Calls relaunchIfIdle(sessionID)
If idle:      Sends "/exit" to iTerm tab -> waits 2s -> sends "pokegent <new_role>@<project> -r <sessionID>"
              Old Claude session ends (SessionEnd hook fires, running file deleted)
              New Claude session starts (new pokegent.sh invocation on SAME tab)
              New running file created with fresh ccd_session_id
              Old running file deleted by SessionEnd hook or EXIT trap
If busy:      Queued in pendingRelaunches map, executed when agent becomes idle
```
**Issues:** The pokegent wrapper dies and restarts. New `ccd_session_id` means new identity. Old messages, sprite, grid position all lost. iTerm2 tab preserved but Dynamic Profile file changes.

**With pokegent_id:** This is the hardest case. The pokegent wrapper (shell process) dies on `/exit` and a new one starts. The new invocation generates a fresh pokegent_id. To preserve identity across role changes:
- Option A: Pass the old pokegent_id to the new invocation via env var or flag (`pokegent <profile> -r <id> --inherit-id <old_pokegent_id>`)
- Option B: The server updates the running file in-place (new role, project, profile) and only restarts the Claude session, not the pokegent wrapper
- Option C: Accept that role/project change creates a new pokegent identity (simplest, current behavior made explicit)

**Recommendation:** Option A for now. The relaunch command becomes `pokegent <new_role>@<project> -r <sessionID> --pokegent-id <old_pokegent_id>`. pokegent.sh uses the inherited ID instead of generating a fresh one. Sprite, grid position, task_group all preserved.

---

### 7. Subagent Spawn (Claude's Agent Tool)

**Current:**
```
Claude calls Agent tool -> PreToolUse hook caches prompt in ephemeral-pending/
SubagentStart hook fires -> consumes pending -> creates ephemeral/{agent_id}.json
                            parent_session_id = POKEGENTS_SESSION_ID (ccd_session_id)
SubagentStop hook fires  -> marks completed
```
**Issues:** `parent_session_id` uses `POKEGENTS_SESSION_ID` (which is `ccd_session_id`). If parent's identity changes (role change), the link breaks.

**With pokegent_id:** `parent_session_id` = pokegent_id (stable). Link survives role changes if Option A is used. Ephemeral agents don't get their own pokegent_id (they're managed by Claude, not pokegent).

---

### 8. MCP spawn_agent

**Current:**
```
MCP tool:     POST /api/launch -> same as flow #2
              Polls for new agent by comparing session_id lists (before/after)
              Sets name, task_group, sends message using ccd_session_id || session_id
```
**Issues:** Detection uses `session_id` comparison which may be unstable during reconciliation.

**With pokegent_id:** Detection uses `pokegent_id` (stable from creation). No reconciliation race. MCP tools always reference `pokegent_id`.

---

### 9. Session End (/exit, Ctrl+D, crash)

**Current:**
```
pokegent.sh EXIT trap:  Deletes running file, deletes Dynamic Profile
SessionEnd hook:        Deletes status file, deletes running files matching *-{session_id}.json
```
**Issues:** Trap uses `$running_file` (initial filename). If file was renamed by hook (fork case), trap deletes nothing. SessionEnd hook catches by `session_id` pattern match.

**With pokegent_id:** Running file never renamed. Trap always finds it. SessionEnd hook matches by pokegent_id. Clean.

---

### 10. Hook Reconciliation (SessionStart)

**Current:** 3-pass matching:
1. Match `ccd_session_id` field == `POKEGENTS_SESSION_ID` env var
2. Match `session_id` field == hook event session_id (legacy)
3. TTY fallback

Then patches `session_id` field and renames file.

**With pokegent_id:** 1-pass matching:
1. Match `pokegent_id` field == `POKEGENT_ID` env var
Then update `claude_session_id` field. No file rename. No collision guard needed (pokegent_id is unique per invocation).

---

## Proposed ID System

### The pokegent_id

- Generated once by pokegent.sh at launch (`uuidgen`)
- Stored in running file as `pokegent_id`
- Passed to Claude via `POKEGENT_ID` env var
- Used as the key for ALL internal systems
- Never changes, never gets patched

### Downstream Mappings (stored in running file, not used as keys)

```json
{
  "pokegent_id": "abc-123",
  "claude_session_id": "def-456",
  "iterm_session_id": "ghi-789",
  "tty": "/dev/ttys001",
  "pid": 12345,
  "claude_pid": 67890
}
```

### What Changes

| System | Current Key | New Key |
|--------|-------------|---------|
| Running filename | `{profile}-{session_id}.json` (mutable) | `{profile}-{pokegent_id}.json` (stable) |
| Status filename | `{session_id}.json` (mutable) | `{pokegent_id}.json` (stable) |
| Dynamic Profile | `pokegents-session-{session_id}.json` (stale after rename) | `pokegents-session-{pokegent_id}.json` (stable) |
| Dashboard agent map | keyed by session_id | keyed by pokegent_id |
| Grid layout | keyed by session_id | keyed by pokegent_id |
| Message mailbox | `messages/{ccd_session_id}/` | `messages/{pokegent_id}/` |
| Search index | keyed by session_id | keyed by pokegent_id (+ claude_session_id for transcript lookup) |
| Agent order | list of session_ids | list of pokegent_ids |
| Sprite overrides | N/A (in running file now) | N/A |
| Hook reconciliation | 3-pass, renames file | 1-pass, updates field |

---

## Migration Plan

### For Users (you and your coworker)

**Step 1: Update code** (pull main after merge)
```bash
git pull origin main
./install.sh  # re-runs hook setup
```

**Step 2: Restart dashboard**
```bash
pokegent dashboard build
```

**Step 3: Running agents auto-migrate**
- Existing running files will be read with backward compat
- `ccd_session_id` treated as `pokegent_id` if no `pokegent_id` field exists
- `session_id` treated as `claude_session_id`
- No need to restart agents; they'll work with old field names

**Step 4: New agents use new fields**
- Newly launched agents get `pokegent_id` in running file
- Old agents continue working until they exit naturally

**Step 5: Clean up** (after all old agents have exited)
- Delete `~/.pokegents/sprite-overrides.json` if still present
- Old running files with `ccd_session_id` instead of `pokegent_id` are cleaned up on exit

### Backward Compatibility Rules

1. **Reading running files:** If `pokegent_id` field missing, use `ccd_session_id` as pokegent_id
2. **Reading status files:** If filename is a Claude session ID (not a pokegent_id), still works via lookup
3. **Hook events:** `POKEGENT_ID` env var used if set; falls back to `POKEGENTS_SESSION_ID`; falls back to event session_id
4. **Search index:** Dual-keyed by both pokegent_id and claude_session_id during transition
5. **MCP tools:** Accept 8-char prefix of either ID type, resolve to pokegent_id
6. **Grid layout:** Agent IDs in layout checked against both pokegent_id and session_id

### Implementation Order

**Phase 1: Add pokegent_id (additive, no breaking changes)**
1. pokegent.sh: Generate `pokegent_id` field, pass as `POKEGENT_ID` env var
2. Running file: Add `pokegent_id` field alongside existing `ccd_session_id`
3. Go server: Read pokegent_id from running file, fall back to ccd_session_id
4. Frontend: Use `agent.pokegent_id || agent.ccd_session_id || agent.session_id`

**Phase 2: Key internal systems by pokegent_id**
5. Running filename: `{profile}-{pokegent_id}.json`
6. Status filename: `{pokegent_id}.json`
7. Dynamic Profile: `pokegents-session-{pokegent_id}.json`
8. Dashboard maps: keyed by pokegent_id
9. Hook: 1-pass matching by pokegent_id, update `claude_session_id` field (no rename)

**Phase 3: Simplify**
10. Remove 3-pass hook reconciliation
11. Remove file rename logic
12. Remove `ccd_session_id` (pokegent_id replaces it)
13. Remove `resolveSessionID` complexity (direct pokegent_id lookup)
14. Rename `session_id` to `claude_session_id` in running file

**Phase 4: Decouple**
15. Abstract Claude-specific logic behind an interface (CLI adapter)
16. Abstract iTerm-specific logic behind terminal interface (already partially done)
17. Session history keyed by pokegent_id with claude_session_id as a metadata field

---

## Role/Project Change: Identity Preservation

When a user changes role/project, the current `relaunchIfIdle` kills the pokegent wrapper and starts a new one. This loses the pokegent identity.

**Fix:** Add `--pokegent-id <id>` flag to pokegent.sh:
```bash
pokegent engineer@client -r <claude_sid> --pokegent-id <old_pokegent_id>
```

pokegent.sh checks: if `--pokegent-id` provided, use it instead of generating a fresh UUID. The relaunch command in server.go becomes:
```go
cmd := fmt.Sprintf("pokegent %s -r %s --pokegent-id %s", target, sessionID, agent.PokegentID)
```

This preserves:
- Sprite (same pokegent_id, same running file location)
- Grid position (same ID in layout)
- Task group (same running file)
- Message mailbox (same pokegent_id)
- Dynamic Profile (same filename)

---

## Open Questions

1. **Should resumed agents share pokegent_id with the original?** Currently `ccd_session_id` is always fresh on resume. If we keep that behavior, resumed agents are new identities. If we want "same agent, new session," we need `--pokegent-id` on resume too.

2. **How long should search index keep old pokegent_ids?** Currently indefinite. Consider adding a TTL or max entries.

3. **Should the MCP server expose pokegent_id in list_agents?** Yes, it should be the primary ID shown, with claude_session_id as secondary.

4. **What happens if two pokegent instances somehow get the same pokegent_id?** UUID collision is astronomically unlikely, but add a guard: if running file already exists for a pokegent_id, abort with error.
