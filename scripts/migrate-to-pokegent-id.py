#!/usr/bin/env python3
"""
migrate-to-pokegent-id.py — One-time migration for the pokegent_id + identity store refactor.

WHAT THIS DOES:
  This script migrates pokegents from the old system (where session_id was the primary key
  and everything lived in the running file) to the new system (where pokegent_id is the
  stable internal ID and agent identity is stored separately from process state).

  Specifically:
  1. Creates a timestamped backup of ~/.pokegents/ before any changes
  2. Scans running files to build a session_id -> pokegent_id mapping
  3. Creates persistent identity files (~/.pokegents/agents/{pokegent_id}.json)
     containing: display_name, sprite, role, project, task_group, model, effort, created_at
  4. Slims running files to process-state only (pid, tty, iterm_session_id, etc.)
  5. Renames running/status/Dynamic Profile files from session_id to pokegent_id
  6. Remaps persistent stores (grid-layout, name-overrides, agent-order) to pokegent_id keys
  7. Backfills pokegent_id and sprite columns in the search DB

WHY:
  The old system used session_id as the key for everything. But session_id is Claude Code's
  conversation ID which changes on resume/fork, causing sprites, names, and grid positions
  to be lost. pokegent_id is stable and never changes.

  Additionally, identity data (sprite, name, etc.) was stored in the running file which
  gets deleted when an agent exits. Now identity lives in agents/ and persists forever.

SPRITE PRIORITY (preserves what the old dashboard was showing):
  1. sprite-overrides.json (user explicitly picked via sprite picker)
  2. Hash of ccd_session_id (deterministic, matches old dashboard's JS hashString)
  3. Hash of session_id (fallback)
  4. Random (truly last resort, only if no IDs exist)

HOW TO RUN:
  ./scripts/migrate-to-pokegent-id.sh        # wrapper that calls this script
  pokegent dashboard build                    # rebuild and restart after migration
  # Hard refresh browser (Cmd+Shift+R)

IF SOMETHING GOES WRONG:
  A backup is created at ~/.pokegents/backups/pre-migration-{timestamp}/
  To restore:
    rm -rf ~/.pokegents/running ~/.pokegents/status ~/.pokegents/agents
    cp -r ~/.pokegents/backups/pre-migration-{timestamp}/running ~/.pokegents/
    cp -r ~/.pokegents/backups/pre-migration-{timestamp}/status ~/.pokegents/
    # Then also restore: grid-layout.json, name-overrides.json, agent-order.json,
    # session-id-map.json from the backup directory.
    # The search.db changes are additive (new columns) and won't break old code.

IDEMPOTENT:
  Safe to run multiple times. Identity files that already exist get updated (not overwritten).
  Running files that are already slim stay slim. Renames that already happened are skipped.
"""

import json
import os
import shutil
import sqlite3
import sys
import time as time_mod
from datetime import datetime
from pathlib import Path

# ── Argument parsing ──

if len(sys.argv) < 3:
    print("Usage: migrate-to-pokegent-id.py <pokegents_data_dir> <sprite_list_file>")
    print("  pokegents_data_dir: path to ~/.pokegents (or $POKEGENTS_DATA)")
    print("  sprite_list_file:   path to dashboard/web/public/sprites/_base_sprites.txt")
    sys.exit(1)

DATA_DIR = Path(sys.argv[1])
SPRITE_LIST_PATH = Path(sys.argv[2])
RUNNING_DIR = DATA_DIR / "running"
STATUS_DIR = DATA_DIR / "status"
AGENTS_DIR = DATA_DIR / "agents"
SEARCH_DB = DATA_DIR / "search.db"
OVERRIDES_FILE = DATA_DIR / "sprite-overrides.json"
DYN_PROFILE_DIR = Path.home() / "Library" / "Application Support" / "iTerm2" / "DynamicProfiles"

# ── Load sprite list ──

with open(SPRITE_LIST_PATH) as f:
    SPRITES = [line.strip() for line in f if line.strip()]
print(f"Sprite list: {len(SPRITES)} sprites")


def hash_string(s: str) -> int:
    """JS-compatible hashString function.

    This MUST match the JavaScript implementation in CreatureIcon.tsx:
      let h = 0;
      for (const c of s) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
      return Math.abs(h);

    Python's arbitrary-precision ints need manual 32-bit signed overflow handling.
    The zsh shell CANNOT do this correctly (its integers are 64-bit), which is why
    we use Python here instead of bash.
    """
    h = 0
    for c in s:
        h = ((h << 5) - h) + ord(c)
        h = h & 0xFFFFFFFF  # mask to 32 bits
        if h >= 0x80000000:
            h -= 0x100000000  # convert to signed
    return abs(h)


def hash_sprite(session_id: str) -> str:
    """Pick a sprite deterministically from a session ID.

    This reproduces what the old dashboard frontend was showing:
    POKEMON_SPRITES[hashString(ccd_session_id) % POKEMON_SPRITES.length]
    """
    return SPRITES[hash_string(session_id) % len(SPRITES)]


# ── Load sprite overrides (user-picked sprites from old system) ──

# sprite-overrides.json was the old mechanism for persisting user sprite choices.
# Keys are session_id or ccd_session_id. Values are sprite names like "jirachi".
# This file is checked FIRST so user-picked sprites are always preserved.
overrides = {}
if OVERRIDES_FILE.exists():
    with open(OVERRIDES_FILE) as f:
        overrides = json.load(f)
    print(f"Found sprite-overrides.json ({len(overrides)} entries)")
else:
    print("No sprite-overrides.json found (that's fine — most users won't have one)")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 0: Create backup
# ══════════════════════════════════════════════════════════════════════════

print("=== Step 0: Create backup ===")
timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup_dir = DATA_DIR / "backups" / f"pre-migration-{timestamp}"
backup_dir.mkdir(parents=True, exist_ok=True)

# Back up directories that will be modified
for dirname in ["running", "status", "agents"]:
    src = DATA_DIR / dirname
    if src.exists():
        shutil.copytree(src, backup_dir / dirname)
        print(f"  Backed up {dirname}/")

# Back up individual files that will be modified
for filename in ["grid-layout.json", "name-overrides.json", "agent-order.json",
                 "session-id-map.json", "sprite-overrides.json"]:
    src = DATA_DIR / filename
    if src.exists():
        shutil.copy2(src, backup_dir / filename)
        print(f"  Backed up {filename}")

# Back up search DB
if SEARCH_DB.exists():
    shutil.copy2(SEARCH_DB, backup_dir / "search.db")
    print("  Backed up search.db")

print(f"  Backup location: {backup_dir}")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 1: Scan running files and build ID mapping
# ══════════════════════════════════════════════════════════════════════════
#
# Each running file has up to 3 IDs:
#   - session_id: Claude's conversation ID (MUTABLE — patched by hook on SessionStart)
#   - ccd_session_id: pokegent.sh-generated UUID (STABLE — never changes)
#   - pokegent_id: new stable ID (equals ccd_session_id for migrated agents)
#
# The mapping tells us: for each old session_id key used in grid-layout, name-overrides,
# etc., what is the new pokegent_id to use instead?

print("=== Step 1: Scan running files and build ID mapping ===")

id_map = {}       # old_id -> pokegent_id (for remapping persistent stores)
agent_info = {}   # pokegent_id -> {sid, ccd, profile, name, sprite, path}

if RUNNING_DIR.exists():
    for rf_path in sorted(RUNNING_DIR.glob("*.json")):
        try:
            with open(rf_path) as f:
                rf = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        sid = rf.get("session_id", "")
        ccd = rf.get("ccd_session_id", "")
        pgid = rf.get("pokegent_id", "")
        profile = rf.get("profile", "")
        name = rf.get("display_name", "unknown")

        # pokegent_id priority: explicit pokegent_id > ccd_session_id > session_id
        pokegent_id = pgid or ccd or sid
        if not pokegent_id:
            print(f"  SKIP: {rf_path.name} (no IDs found — corrupt file?)")
            continue

        # Build the remapping table so we can update grid-layout, name-overrides, etc.
        if sid and sid != pokegent_id:
            id_map[sid] = pokegent_id
        if ccd and ccd != pokegent_id and ccd != sid:
            id_map[ccd] = pokegent_id

        # Determine the correct sprite (preserving what the old dashboard showed)
        existing_sprite = rf.get("sprite", "")
        if existing_sprite:
            # Agent already has a sprite (from a previous migration run or new code)
            sprite = existing_sprite
        else:
            # Priority 1: sprite-overrides.json (user explicitly picked via UI)
            sprite = overrides.get(ccd, "") or overrides.get(sid, "")
            # Priority 2: hash of ccd_session_id (what old dashboard computed via JS)
            if not sprite and ccd:
                sprite = hash_sprite(ccd)
            # Priority 3: hash of session_id (fallback for very old agents without ccd_session_id)
            if not sprite and sid:
                sprite = hash_sprite(sid)

        agent_info[pokegent_id] = {
            "sid": sid, "ccd": ccd, "profile": profile,
            "name": name, "sprite": sprite, "path": str(rf_path),
        }

        print(f"  {name}: sid={sid[:8] if sid else '?'} -> pokegent_id={pokegent_id[:8]} sprite={sprite}")

print(f"  Mapped {len(id_map)} session_id -> pokegent_id entries")
print()


def remap_id(old_id: str) -> str:
    """Map an old session_id to its pokegent_id, or return unchanged if not in the mapping."""
    return id_map.get(old_id, old_id)


# ══════════════════════════════════════════════════════════════════════════
# STEP 2: Create persistent identity files
# ══════════════════════════════════════════════════════════════════════════
#
# Identity files live at ~/.pokegents/agents/{pokegent_id}.json and are NEVER deleted
# automatically. They store everything that should outlive a session:
#   display_name, sprite, role, project, profile, task_group, model, effort, created_at
#
# When an agent exits, its running file is deleted but its identity file persists.
# When resumed, the identity file provides sprite, name, etc. without needing the
# search DB or sprite-overrides.json.

print("=== Step 2: Create persistent identity files ===")
AGENTS_DIR.mkdir(parents=True, exist_ok=True)
created_ids = 0

if RUNNING_DIR.exists():
    for pgid, info in agent_info.items():
        rf_path = Path(info["path"])
        if not rf_path.exists():
            continue

        try:
            with open(rf_path) as f:
                rf = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        identity_path = AGENTS_DIR / f"{pgid}.json"
        if identity_path.exists():
            # Identity file already exists (from a previous run) — fill in missing fields only
            with open(identity_path) as f:
                identity = json.load(f)
            changed = False
            for field in ["display_name", "sprite", "role", "project", "profile",
                          "task_group", "model", "effort", "created_at"]:
                if not identity.get(field):
                    val = rf.get(field, "") or info.get(field, "")
                    if field == "sprite":
                        val = info["sprite"]  # use our computed sprite, not the running file's
                    if val:
                        identity[field] = val
                        changed = True
            if changed:
                with open(identity_path, "w") as f:
                    json.dump(identity, f, indent=2)
                print(f"  Updated: {info['name']} ({pgid[:8]})")
                created_ids += 1
        else:
            # Brand new identity file — extract all fields from the running file
            identity = {
                "pokegent_id": pgid,
                "display_name": rf.get("display_name", info["name"]),
                "sprite": info["sprite"],
                "role": rf.get("role", ""),
                "project": rf.get("project", ""),
                "profile": rf.get("profile", info["profile"]),
                "task_group": rf.get("task_group", ""),
                "model": rf.get("model", ""),
                "effort": rf.get("effort", ""),
                "created_at": rf.get("created_at", ""),
            }
            with open(identity_path, "w") as f:
                json.dump(identity, f, indent=2)
            print(f"  Created: {info['name']} ({pgid[:8]})")
            created_ids += 1

print(f"  {created_ids} identity files created/updated")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 3: Slim down and rename running files
# ══════════════════════════════════════════════════════════════════════════
#
# Running files now contain ONLY ephemeral process state:
#   pokegent_id, profile, session_id, ccd_session_id, pid, claude_pid, tty, iterm_session_id
#
# All identity data (name, sprite, role, project, etc.) has been moved to the
# identity file in Step 2.
#
# Files are renamed from {profile}-{session_id}.json to {profile}-{pokegent_id}.json
# so they're keyed by the stable ID. The hook no longer renames files on SessionStart.

print("=== Step 3: Slim down and rename running files ===")
patched = 0

if RUNNING_DIR.exists():
    for pgid, info in agent_info.items():
        rf_path = Path(info["path"])
        if not rf_path.exists():
            continue

        try:
            with open(rf_path) as f:
                rf = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        # Keep only process-state fields
        slim = {
            "pokegent_id": pgid,
            "profile": rf.get("profile", info["profile"]),
            "session_id": rf.get("session_id", ""),
            "ccd_session_id": rf.get("ccd_session_id", ""),
            "pid": rf.get("pid", 0),
            "claude_pid": rf.get("claude_pid", 0),
            "tty": rf.get("tty", ""),
            "iterm_session_id": rf.get("iterm_session_id", ""),
        }
        with open(rf_path, "w") as f:
            json.dump(slim, f, indent=2)

        # Rename to {profile}-{pokegent_id}.json
        expected_name = f"{info['profile']}-{pgid}.json"
        if rf_path.name != expected_name:
            new_path = RUNNING_DIR / expected_name
            if new_path.exists() and new_path != rf_path:
                print(f"  CONFLICT: {expected_name} already exists, skipping rename")
            else:
                rf_path.rename(new_path)
                print(f"  Renamed: {rf_path.name} -> {expected_name}")
                patched += 1
        else:
            print(f"  Slimmed: {info['name']}")
            patched += 1

print(f"  {patched} running files updated")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 4: Rename status files
# ══════════════════════════════════════════════════════════════════════════
#
# Status files were keyed by session_id. Now keyed by pokegent_id.
# The hook writes status using POKEGENT_ID env var, so new sessions will
# automatically use the right key.

print("=== Step 4: Rename status files ===")
renamed = 0

if STATUS_DIR.exists():
    for sf_path in sorted(STATUS_DIR.glob("*.json")):
        old_id = sf_path.stem
        new_id = id_map.get(old_id)
        if new_id:
            new_path = STATUS_DIR / f"{new_id}.json"
            if new_path.exists() and new_path != sf_path:
                print(f"  CONFLICT: {new_id}.json already exists, skipping")
            else:
                sf_path.rename(new_path)
                print(f"  Renamed: {old_id[:8]}.json -> {new_id[:8]}.json")
                renamed += 1

print(f"  {renamed} status files renamed")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 5: Remap grid-layout.json
# ══════════════════════════════════════════════════════════════════════════
#
# Grid layout stores card positions keyed by agent ID. Old keys are session_ids.
# Remap to pokegent_ids so positions are preserved when session_id changes.

print("=== Step 5: Remap grid-layout.json ===")
grid_file = DATA_DIR / "grid-layout.json"

if grid_file.exists():
    with open(grid_file) as f:
        data = json.load(f)
    layouts = data.get("layouts", {})
    new_layouts = {}
    remapped = 0
    for key, val in layouts.items():
        new_key = remap_id(key)
        if new_key != key:
            remapped += 1
        new_layouts[new_key] = val
    data["layouts"] = new_layouts
    with open(grid_file, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  Remapped {remapped} layout entries")
else:
    print("  No grid-layout.json found")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 6: Remap name-overrides.json
# ══════════════════════════════════════════════════════════════════════════
#
# Name overrides store custom display names keyed by agent ID.
# Note: with the new identity store, name-overrides.json becomes redundant
# (names are in agents/{pokegent_id}.json). But we still remap for backward compat.

print("=== Step 6: Remap name-overrides.json ===")
name_file = DATA_DIR / "name-overrides.json"

if name_file.exists():
    with open(name_file) as f:
        data = json.load(f)
    new_data = {}
    remapped = 0
    for key, val in data.items():
        new_key = remap_id(key)
        if new_key != key:
            remapped += 1
        new_data[new_key] = val
    with open(name_file, "w") as f:
        json.dump(new_data, f, indent=2)
    print(f"  Remapped {remapped} entries")
else:
    print("  No name-overrides.json found")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 7: Remap agent-order.json
# ══════════════════════════════════════════════════════════════════════════
#
# Agent order is a JSON array of agent IDs controlling display order in the dashboard.

print("=== Step 7: Remap agent-order.json ===")
order_file = DATA_DIR / "agent-order.json"

if order_file.exists():
    with open(order_file) as f:
        data = json.load(f)
    new_data = [remap_id(x) for x in data]
    remapped = sum(1 for a, b in zip(data, new_data) if a != b)
    with open(order_file, "w") as f:
        json.dump(new_data, f, indent=2)
    print(f"  Remapped {remapped} entries")
else:
    print("  No agent-order.json found")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 8: Update session-id-map.json
# ══════════════════════════════════════════════════════════════════════════
#
# Maps ccd_session_id -> claude_session_id. Add pokegent_id entries alongside.

print("=== Step 8: Update session-id-map.json ===")
sid_map_file = DATA_DIR / "session-id-map.json"

if sid_map_file.exists():
    with open(sid_map_file) as f:
        data = json.load(f)
    added = 0
    for old_key, new_key in id_map.items():
        if old_key in data and new_key not in data:
            data[new_key] = data[old_key]
            added += 1
    with open(sid_map_file, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  Added {added} pokegent_id entries")
else:
    print("  No session-id-map.json found")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 9: Backfill search DB
# ══════════════════════════════════════════════════════════════════════════
#
# The search DB (SQLite) indexes session transcripts for the PC Box browser.
# We add pokegent_id and sprite columns, then backfill from running file data.
# This is additive — old code that doesn't know about these columns will still work.

print("=== Step 9: Backfill search DB ===")

if SEARCH_DB.exists():
    conn = sqlite3.connect(str(SEARCH_DB))
    # Add columns if they don't exist yet (ALTER TABLE is a no-op if column exists)
    try:
        conn.execute("ALTER TABLE session_meta ADD COLUMN sprite TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE session_meta ADD COLUMN pokegent_id TEXT")
    except sqlite3.OperationalError:
        pass

    synced = 0
    for pgid, info in agent_info.items():
        sprite = info["sprite"]
        sid = info["sid"]
        ccd = info["ccd"]

        # Update all rows that match any of this agent's IDs
        for search_id in [sid, ccd, pgid]:
            if not search_id:
                continue
            if pgid:
                conn.execute(
                    "UPDATE session_meta SET pokegent_id = ? WHERE session_id = ?",
                    (pgid, search_id))
            if sprite:
                conn.execute(
                    "UPDATE session_meta SET sprite = ? WHERE session_id = ? AND (sprite IS NULL OR sprite = '')",
                    (sprite, search_id))
        synced += 1

    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM session_meta").fetchone()[0]
    has_pgid = conn.execute(
        "SELECT COUNT(*) FROM session_meta WHERE pokegent_id IS NOT NULL AND pokegent_id != ''").fetchone()[0]
    has_sprite = conn.execute(
        "SELECT COUNT(*) FROM session_meta WHERE sprite IS NOT NULL AND sprite != ''").fetchone()[0]
    conn.close()

    print(f"  Synced {synced} agents")
    print(f"  Search DB: {has_pgid}/{total} have pokegent_id, {has_sprite}/{total} have sprites")
else:
    print("  No search.db found (will be created on next dashboard start)")
print()


# ══════════════════════════════════════════════════════════════════════════
# STEP 10: Rename iTerm2 Dynamic Profiles
# ══════════════════════════════════════════════════════════════════════════
#
# iTerm2 Dynamic Profiles control per-session tab icons (Pokemon sprites).
# Files were named pokegents-session-{session_id}.json. Now named by pokegent_id.
# iTerm2 watches this directory and picks up changes automatically.
#
# Only relevant on macOS with iTerm2. Skipped silently on other platforms.

print("=== Step 10: Rename iTerm2 Dynamic Profiles ===")
renamed_dp = 0

if DYN_PROFILE_DIR.exists():
    for dp in sorted(DYN_PROFILE_DIR.glob("pokegents-session-*.json")):
        old_id = dp.stem.replace("pokegents-session-", "")
        new_id = id_map.get(old_id)
        if new_id:
            new_path = DYN_PROFILE_DIR / f"pokegents-session-{new_id}.json"
            if new_path.exists() and new_path != dp:
                print(f"  CONFLICT: pokegents-session-{new_id}.json already exists, skipping")
            else:
                dp.rename(new_path)
                print(f"  Renamed: {old_id[:8]} -> {new_id[:8]}")
                renamed_dp += 1
    print(f"  {renamed_dp} Dynamic Profiles renamed")
else:
    print("  No iTerm2 Dynamic Profiles directory found (non-macOS or iTerm2 not installed)")
print()


# ══════════════════════════════════════════════════════════════════════════
# DONE
# ══════════════════════════════════════════════════════════════════════════

print("=== Migration complete ===")
print()
print("Backup location:")
print(f"  {backup_dir}")
print()
print("Next steps:")
print("  1. pokegent dashboard build   # rebuild and restart the dashboard")
print("  2. Hard refresh browser        # Cmd+Shift+R to pick up new frontend code")
print()
print("To restore from backup if something went wrong:")
print(f"  cp -r {backup_dir}/running/ {DATA_DIR}/running/")
print(f"  cp -r {backup_dir}/status/ {DATA_DIR}/status/")
print(f"  cp {backup_dir}/*.json {DATA_DIR}/")
print(f"  # Then: pokegent dashboard build")
print()
print("Notes:")
print("  - Active agents preserve their current dashboard sprites")
print("  - Historical PC Box sessions without sprites show as pokeball")
print("  - Grid positions, names, and agent order are preserved")
print("  - Identity files (agents/) are NEVER deleted automatically")
print("  - Old sprite-overrides.json can be deleted after verifying everything works")
