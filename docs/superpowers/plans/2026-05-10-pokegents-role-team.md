# Pokegents Role Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a seven-role agent team in `~/.pokegents/roles/` (Lead, Builder, Reviewer, QA, Designer, Researcher, Debugger) by writing new JSON files, rewriting existing stubs, and renaming `pm` → `lead` and `implementer` → `builder`.

**Architecture:** Data-only change. Each role is a single JSON file in `~/.pokegents/roles/` with the schema `{title, emoji, system_prompt, skip_permissions, model, effort}`. The `pokegent.sh` resolution flow composes a role with a project (`pokegent <role>@<project>`) at launch — no code changes required. The four existing stub files are backed up before being overwritten or deleted.

**Tech Stack:** Bash, `jq` (JSON validation), `~/.pokegents/` data directory, the installed `pokegent` CLI shim.

**Note on commits:** All role files live in `~/.pokegents/roles/` which is outside the repo. There is nothing for `git` to track during the install steps. The only `git commit` is at the end, updating the spec to mark the design as implemented.

---

## File Structure

| Path | Action | Purpose |
|---|---|---|
| `~/.pokegents/roles/.backup-<timestamp>/` | Create directory | Hold pre-install backups |
| `~/.pokegents/roles/.backup-<timestamp>/{pm,implementer,reviewer,researcher}.json` | Copy | Recovery if something goes wrong |
| `~/.pokegents/roles/lead.json` | Create | Architect / decomposer role |
| `~/.pokegents/roles/builder.json` | Create | Primary implementer role |
| `~/.pokegents/roles/reviewer.json` | Overwrite | Adversarial code review (replaces stub) |
| `~/.pokegents/roles/qa.json` | Create | End-to-end behavioral verification |
| `~/.pokegents/roles/designer.json` | Create | UI/UX decisions |
| `~/.pokegents/roles/researcher.json` | Overwrite | Long-form investigation (replaces stub) |
| `~/.pokegents/roles/debugger.json` | Create | Root-cause analysis |
| `~/.pokegents/roles/pm.json` | Delete | Content moved to `lead.json` |
| `~/.pokegents/roles/implementer.json` | Delete | Content moved to `builder.json` |
| `docs/superpowers/specs/2026-05-10-pokegents-role-team-design.md` | Modify (final task) | Add "Status: Implemented" header line |

---

## Task 1: Pre-flight check — no active sessions using `pm` or `implementer`

**Files:** Read-only scan of `~/.pokegents/running/*.json`. No writes.

- [ ] **Step 1: Scan running sessions for old role names**

Run:
```bash
jq -r '.profile_name // "(none)"' ~/.pokegents/running/*.json 2>/dev/null | grep -E '^(pm|implementer)@' || echo "NONE_MATCH"
```

Expected: output is exactly `NONE_MATCH`.

- [ ] **Step 2: If any match, stop and surface to user**

If the previous step found any matches (i.e. did not print `NONE_MATCH`), do not proceed. Tell the user:
- Which sessions are running with the old role names (one per line).
- That the install will continue working on those sessions for their lifetime, but re-launching them by the old role name will fail.
- Ask whether to stop the affected sessions (via the dashboard or by exiting the agents) before continuing, or to proceed anyway accepting that those re-launch commands will break.

Wait for user direction before continuing the plan.

---

## Task 2: Backup existing role files

**Files:**
- Create: `~/.pokegents/roles/.backup-<timestamp>/` (where `<timestamp>` is the current date in `YYYYMMDD-HHMMSS` form)
- Copy: existing `pm.json`, `implementer.json`, `reviewer.json`, `researcher.json` into that directory

- [ ] **Step 1: Create timestamped backup directory and copy files**

Run:
```bash
BACKUP_DIR="$HOME/.pokegents/roles/.backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp ~/.pokegents/roles/pm.json ~/.pokegents/roles/implementer.json ~/.pokegents/roles/reviewer.json ~/.pokegents/roles/researcher.json "$BACKUP_DIR/"
echo "$BACKUP_DIR"
ls -la "$BACKUP_DIR"
```

Expected: prints the backup directory path, then lists four `.json` files inside it.

- [ ] **Step 2: Verify backups are byte-identical to originals**

Run:
```bash
for f in pm implementer reviewer researcher; do
  if diff -q ~/.pokegents/roles/$f.json "$BACKUP_DIR/$f.json" > /dev/null; then
    echo "$f: OK"
  else
    echo "$f: MISMATCH"
  fi
done
```

Expected: all four lines say `OK`. If any say `MISMATCH`, stop and investigate.

---

## Task 3: Write `lead.json`

**Files:**
- Create: `~/.pokegents/roles/lead.json`

- [ ] **Step 1: Write the file**

Write the following exact content to `~/.pokegents/roles/lead.json`:

```json
{
  "title": "Lead",
  "emoji": "🧭",
  "system_prompt": "You are the lead agent for this project. Hold the big picture: decompose work, make architectural calls, and write specs before code gets written. Use the brainstorming skill to produce design specs in `docs/superpowers/specs/`, and the writing-plans skill to produce implementation plans in `docs/superpowers/plans/`. Delegate execution to the Builder via MCP messaging; do not write production code yourself unless the change is trivially small. Push back on scope creep — your job is to keep the project coherent.",
  "skip_permissions": null,
  "model": null,
  "effort": null
}
```

- [ ] **Step 2: Validate JSON parses and required fields exist**

Run:
```bash
jq -e '. | (.title == "Lead") and (.emoji == "🧭") and (.system_prompt | length > 100) and (has("skip_permissions") and has("model") and has("effort"))' ~/.pokegents/roles/lead.json
```

Expected: prints `true` and exits 0. Any other output or exit code means the file is malformed.

---

## Task 4: Write `builder.json`

**Files:**
- Create: `~/.pokegents/roles/builder.json`

- [ ] **Step 1: Write the file**

Write the following exact content to `~/.pokegents/roles/builder.json`:

```json
{
  "title": "Builder",
  "emoji": "🔨",
  "system_prompt": "You are the builder agent. Implement features and fixes from the Lead's specs and plans. Use test-driven-development and verification-before-completion skills rigorously: write tests first, run them, and never claim done without verification output. Follow existing codebase patterns. When you finish a task, report changed files and the exact verification commands you ran. Coordinate via MCP before editing shared hotspots and never revert another agent's work without checking with them.",
  "skip_permissions": null,
  "model": null,
  "effort": null
}
```

- [ ] **Step 2: Validate JSON parses and required fields exist**

Run:
```bash
jq -e '. | (.title == "Builder") and (.emoji == "🔨") and (.system_prompt | length > 100) and (has("skip_permissions") and has("model") and has("effort"))' ~/.pokegents/roles/builder.json
```

Expected: prints `true` and exits 0.

---

## Task 5: Rewrite `reviewer.json`

**Files:**
- Modify (full overwrite): `~/.pokegents/roles/reviewer.json`

- [ ] **Step 1: Overwrite the file**

Write the following exact content to `~/.pokegents/roles/reviewer.json`, replacing the existing stub:

```json
{
  "title": "Reviewer",
  "emoji": "🔍",
  "system_prompt": "You are the reviewer agent. Read code adversarially — look for over-engineering, dead code, premature abstraction, security holes, and inconsistency with existing patterns. Use the simplify and security-review skills. Be specific and actionable: cite file:line and propose the concrete change. Rank findings by severity. You read code; you do not run the app — that is QA's job.",
  "skip_permissions": null,
  "model": null,
  "effort": null
}
```

- [ ] **Step 2: Validate JSON parses and required fields exist**

Run:
```bash
jq -e '. | (.title == "Reviewer") and (.emoji == "🔍") and (.system_prompt | length > 100) and (has("skip_permissions") and has("model") and has("effort"))' ~/.pokegents/roles/reviewer.json
```

Expected: prints `true` and exits 0.

---

## Task 6: Write `qa.json`

**Files:**
- Create: `~/.pokegents/roles/qa.json`

- [ ] **Step 1: Write the file**

Write the following exact content to `~/.pokegents/roles/qa.json`:

```json
{
  "title": "QA",
  "emoji": "🧪",
  "system_prompt": "You are the QA agent. Verify behavior end-to-end by running the app, not by reading code. Exercise the golden path AND edge cases. Hunt for regressions in adjacent features. Read logs, network traffic, and UI state. Report bugs with reproduction steps, expected vs. actual behavior, and severity. You do not fix bugs — you find them and hand off to Builder or Debugger.",
  "skip_permissions": null,
  "model": null,
  "effort": null
}
```

- [ ] **Step 2: Validate JSON parses and required fields exist**

Run:
```bash
jq -e '. | (.title == "QA") and (.emoji == "🧪") and (.system_prompt | length > 100) and (has("skip_permissions") and has("model") and has("effort"))' ~/.pokegents/roles/qa.json
```

Expected: prints `true` and exits 0.

---

## Task 7: Write `designer.json`

**Files:**
- Create: `~/.pokegents/roles/designer.json`

- [ ] **Step 1: Write the file**

Write the following exact content to `~/.pokegents/roles/designer.json`:

```json
{
  "title": "Designer",
  "emoji": "🎨",
  "system_prompt": "You are the designer agent. Own UI and UX decisions: layouts, mockups, visual hierarchy, motion, accessibility. Use Claude Preview or Chrome MCP to test visual changes in a real browser. Touch styling and markup; coordinate with Builder for anything that requires logic changes. Consider responsive behavior and theme contrast. When proposing a design, show the alternatives you considered and why you picked the one you did.",
  "skip_permissions": null,
  "model": null,
  "effort": null
}
```

- [ ] **Step 2: Validate JSON parses and required fields exist**

Run:
```bash
jq -e '. | (.title == "Designer") and (.emoji == "🎨") and (.system_prompt | length > 100) and (has("skip_permissions") and has("model") and has("effort"))' ~/.pokegents/roles/designer.json
```

Expected: prints `true` and exits 0.

---

## Task 8: Rewrite `researcher.json`

**Files:**
- Modify (full overwrite): `~/.pokegents/roles/researcher.json`

- [ ] **Step 1: Overwrite the file**

Write the following exact content to `~/.pokegents/roles/researcher.json`, replacing the existing stub:

```json
{
  "title": "Researcher",
  "emoji": "📚",
  "system_prompt": "You are the researcher agent. Take on multi-hour investigations: external docs, web research, deep codebase archaeology, cross-cutting analysis. Output structured summaries with citations and evidence — never recommend changes the evidence doesn't support. You are distinct from the Explore subagent: Explore is for 'where is X?' lookups inside one conversation; you handle questions whose findings need to outlive a single agent's context.",
  "skip_permissions": null,
  "model": null,
  "effort": null
}
```

- [ ] **Step 2: Validate JSON parses and required fields exist**

Run:
```bash
jq -e '. | (.title == "Researcher") and (.emoji == "📚") and (.system_prompt | length > 100) and (has("skip_permissions") and has("model") and has("effort"))' ~/.pokegents/roles/researcher.json
```

Expected: prints `true` and exits 0.

---

## Task 9: Write `debugger.json`

**Files:**
- Create: `~/.pokegents/roles/debugger.json`

- [ ] **Step 1: Write the file**

Write the following exact content to `~/.pokegents/roles/debugger.json`:

```json
{
  "title": "Debugger",
  "emoji": "🐛",
  "system_prompt": "You are the debugger agent. Use the systematic-debugging skill. Your sole focus is root cause — not workarounds. When invoked, reproduce the issue, isolate variables, and identify what is actually broken. Read logs, traces, and instrumentation. Report root cause and a proposed fix; hand the fix to Builder unless explicitly asked to ship it yourself. Bias toward 'why is this happening?' over 'how do I make this go away?'",
  "skip_permissions": null,
  "model": null,
  "effort": null
}
```

- [ ] **Step 2: Validate JSON parses and required fields exist**

Run:
```bash
jq -e '. | (.title == "Debugger") and (.emoji == "🐛") and (.system_prompt | length > 100) and (has("skip_permissions") and has("model") and has("effort"))' ~/.pokegents/roles/debugger.json
```

Expected: prints `true` and exits 0.

---

## Task 10: Delete obsolete `pm.json` and `implementer.json`

**Files:**
- Delete: `~/.pokegents/roles/pm.json`
- Delete: `~/.pokegents/roles/implementer.json`

- [ ] **Step 1: Confirm backups still exist for both files**

Run:
```bash
ls "$BACKUP_DIR"/pm.json "$BACKUP_DIR"/implementer.json
```

Expected: both files listed. If `$BACKUP_DIR` is no longer in scope (e.g. new shell), substitute the actual path printed by Task 2.

- [ ] **Step 2: Delete the obsolete files**

Run:
```bash
rm ~/.pokegents/roles/pm.json ~/.pokegents/roles/implementer.json
```

Expected: no output, exit 0.

- [ ] **Step 3: Verify deletion**

Run:
```bash
ls ~/.pokegents/roles/pm.json ~/.pokegents/roles/implementer.json 2>&1
```

Expected: two "No such file or directory" lines (one per file).

---

## Task 11: Verify the role library is complete

**Files:** Read-only checks. No writes.

- [ ] **Step 1: Verify the seven expected files exist**

Run:
```bash
ls ~/.pokegents/roles/*.json | xargs -n1 basename | sort
```

Expected output, exactly:
```
builder.json
debugger.json
designer.json
lead.json
qa.json
researcher.json
reviewer.json
```

If `pm.json` or `implementer.json` appears, Task 10 was not completed. If any of the seven expected names is missing, the corresponding Task 3–9 was skipped or failed.

- [ ] **Step 2: Verify every role file is well-formed JSON with the full schema**

Run:
```bash
for f in ~/.pokegents/roles/*.json; do
  jq -e '. | has("title") and has("emoji") and has("system_prompt") and has("skip_permissions") and has("model") and has("effort")' "$f" > /dev/null \
    && echo "$(basename $f): OK" \
    || echo "$(basename $f): MALFORMED"
done
```

Expected: seven lines, each ending in `OK`.

- [ ] **Step 3: Verify `pokegent roles` lists all seven**

Run:
```bash
pokegent roles
```

Expected: output lists at least seven roles, one per line, with titles `Lead`, `Builder`, `Reviewer`, `QA`, `Designer`, `Researcher`, `Debugger` (and their emojis). The exact format depends on `_pokegent_list_roles` formatting in `pokegent.sh`. Confirm visually that each of the seven titles appears.

- [ ] **Step 4: Simulate field reads for all seven roles**

This step mirrors the field extraction `pokegent.sh` performs during resolution (lines 510+: title, emoji, system_prompt). If any role file fails this, `pokegent <role>@current` would fail at launch.

Run:
```bash
for f in ~/.pokegents/roles/*.json; do
  name=$(basename "$f" .json)
  title=$(jq -r '.title' "$f")
  emoji=$(jq -r '.emoji' "$f")
  prompt=$(jq -r '.system_prompt // empty' "$f")
  if [[ -n "$title" && "$title" != "null" && -n "$emoji" && "$emoji" != "null" && -n "$prompt" ]]; then
    echo "$name: title=$title emoji=$emoji prompt_len=${#prompt}"
  else
    echo "$name: FAIL (title='$title' emoji='$emoji' prompt_len=${#prompt})"
  fi
done
```

Expected: seven lines, each showing `name: title=<X> emoji=<Y> prompt_len=<N>` with `N > 100`. No line should contain `FAIL`.

---

## Task 12: End-to-end smoke test

**Files:** None modified. Launches a real `pokegent` session interactively.

- [ ] **Step 1: Launch the Lead role against the default project**

Open a new terminal window or tab (so that the current session is not consumed) and run:
```bash
pokegent lead@current
```

Expected: a new Claude Code session launches. The terminal tab title should show "Lead — pokegents" (or similar — exact format depends on iTerm2 wiring) and the tab color should be the pokegents project color (blue, RGB 100,180,255).

- [ ] **Step 2: Confirm the system prompt loaded**

In the launched session, type the prompt:
```
What is your role?
```

Expected: the agent's reply must contain all three of the following:
- The word "lead" (or "Lead") naming the role
- Reference to architecture, decomposition, or spec-writing as responsibilities
- Mention of delegating implementation to the Builder

If any of those three are missing, the role file was not loaded correctly. Investigate: re-check `~/.pokegents/roles/lead.json` content and that `pokegent` is reading from the expected `~/.pokegents/roles/` directory.

- [ ] **Step 3: Exit the smoke-test session**

In the launched session, type `/exit` (or close the terminal tab). Confirm the session ends cleanly and the tab color/profile is restored.

---

## Task 13: Mark the spec as implemented and commit

**Files:**
- Modify: `docs/superpowers/specs/2026-05-10-pokegents-role-team-design.md`

- [ ] **Step 1: Add an "Implemented" status line to the spec**

Edit `docs/superpowers/specs/2026-05-10-pokegents-role-team-design.md`. Change the header line:

```markdown
**Status:** Approved (brainstorm); implementation plan pending
```

to:

```markdown
**Status:** Implemented 2026-05-10
```

- [ ] **Step 2: Commit the spec update**

Run:
```bash
git add docs/superpowers/specs/2026-05-10-pokegents-role-team-design.md
git commit -m "$(cat <<'EOF'
Mark pokegents role team spec as implemented

Seven role files installed in ~/.pokegents/roles/: lead, builder,
reviewer, qa, designer, researcher, debugger. Obsolete pm.json and
implementer.json removed (content migrated). Old role files backed
up to ~/.pokegents/roles/.backup-<timestamp>/.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: a new commit appears in `git log --oneline -1`.

---

## Rollback

If anything goes wrong before Task 13, restore the original four role files and remove the new ones:

```bash
# Restore originals from backup
cp "$BACKUP_DIR"/*.json ~/.pokegents/roles/

# Remove new files that weren't part of the original set
rm -f ~/.pokegents/roles/lead.json ~/.pokegents/roles/builder.json \
      ~/.pokegents/roles/qa.json ~/.pokegents/roles/designer.json \
      ~/.pokegents/roles/debugger.json

# Confirm state
ls ~/.pokegents/roles/*.json | xargs -n1 basename
```

Expected after rollback: the original four files (`pm.json`, `implementer.json`, `researcher.json`, `reviewer.json`) and nothing else.
