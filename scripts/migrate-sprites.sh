#!/bin/bash
# migrate-sprites.sh — One-time migration for the sprite refactor
#
# What it does:
#   1. Backfills sprite field into running files using the SAME sprite
#      the old dashboard was showing (preserves what users see today)
#   2. Syncs sprites from running files into the search DB
#
# Priority for determining the correct sprite:
#   1. sprite-overrides.json (user explicitly picked via sprite picker)
#   2. Hash of ccd_session_id (what the old dashboard frontend computed)
#   3. Random (last resort, only if no ccd_session_id exists)
#
# Run this AFTER pulling the sprite refactor changes and BEFORE
# restarting the dashboard.
#
# Usage:
#   ./scripts/migrate-sprites.sh
#   pokegent dashboard build

set -euo pipefail

POKEGENTS_DATA="${POKEGENTS_DATA:-$HOME/.pokegents}"
RUNNING_DIR="$POKEGENTS_DATA/running"
SEARCH_DB="$POKEGENTS_DATA/search.db"
OVERRIDES_FILE="$POKEGENTS_DATA/sprite-overrides.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SPRITE_LIST="$SCRIPT_DIR/../dashboard/web/public/sprites/_base_sprites.txt"

if [[ ! -f "$SPRITE_LIST" ]]; then
  echo "Error: sprite list not found at $SPRITE_LIST"
  echo "Run this script from the pokegents repo root: ./scripts/migrate-sprites.sh"
  exit 1
fi

SPRITE_COUNT=$(wc -l < "$SPRITE_LIST" | tr -d ' ')
echo "Sprite list: $SPRITE_COUNT sprites"

# Load overrides if they exist
OVERRIDES="{}"
if [[ -f "$OVERRIDES_FILE" ]]; then
  OVERRIDES=$(cat "$OVERRIDES_FILE")
  echo "Found sprite-overrides.json"
else
  echo "No sprite-overrides.json found (that's fine)"
fi
echo ""

# JS-compatible hash function (matches what the old dashboard frontend used)
# Python is more reliable than zsh for 32-bit signed integer overflow
hash_sprite() {
  local id="$1"
  python3 -c "
import sys
s = sys.argv[1]
h = 0
for c in s:
    h = ((h << 5) - h) + ord(c)
    h = h & 0xFFFFFFFF
    if h >= 0x80000000:
        h -= 0x100000000
h = abs(h)
with open('$SPRITE_LIST') as f:
    sprites = [l.strip() for l in f if l.strip()]
print(sprites[h % len(sprites)])
" "$id"
}

# ── Step 1: Backfill sprites into running files ──

echo "=== Step 1: Backfill running files ==="
patched=0
skipped=0
from_override=0
from_hash=0
from_random=0

for rf in "$RUNNING_DIR"/*.json; do
  [[ -f "$rf" ]] || continue

  existing=$(jq -r '.sprite // empty' "$rf" 2>/dev/null)
  name=$(jq -r '.display_name // "unknown"' "$rf" 2>/dev/null)

  if [[ -n "$existing" ]]; then
    echo "  OK:      $name → $existing"
    skipped=$((skipped + 1))
    continue
  fi

  sid=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
  ccd=$(jq -r '.ccd_session_id // empty' "$rf" 2>/dev/null)
  sprite=""

  # Priority 1: Check sprite-overrides.json (user explicitly picked these)
  if [[ -n "$ccd" ]]; then
    sprite=$(echo "$OVERRIDES" | jq -r --arg id "$ccd" '.[$id] // empty' 2>/dev/null)
  fi
  if [[ -z "$sprite" && -n "$sid" ]]; then
    sprite=$(echo "$OVERRIDES" | jq -r --arg id "$sid" '.[$id] // empty' 2>/dev/null)
  fi
  if [[ -n "$sprite" ]]; then
    from_override=$((from_override + 1))
  fi

  # Priority 2: Hash ccd_session_id (what old dashboard was showing)
  if [[ -z "$sprite" && -n "$ccd" ]]; then
    sprite=$(hash_sprite "$ccd")
    from_hash=$((from_hash + 1))
  fi

  # Priority 3: Hash session_id as fallback
  if [[ -z "$sprite" && -n "$sid" ]]; then
    sprite=$(hash_sprite "$sid")
    from_hash=$((from_hash + 1))
  fi

  # Priority 4: Random (truly last resort)
  if [[ -z "$sprite" ]]; then
    idx=$(( RANDOM % SPRITE_COUNT ))
    sprite=$(sed -n "$((idx + 1))p" "$SPRITE_LIST")
    from_random=$((from_random + 1))
  fi

  jq --arg s "$sprite" '.sprite = $s' "$rf" > "${rf}.tmp" && mv "${rf}.tmp" "$rf"
  echo "  Patched: $name → $sprite"
  patched=$((patched + 1))
done

echo ""
echo "  Results: $patched patched, $skipped already had sprites"
echo "  Sources: $from_override from overrides, $from_hash from hash (preserved dashboard view), $from_random random"
echo ""

# ── Step 2: Sync sprites to search DB ──

echo "=== Step 2: Sync sprites to search DB ==="

if [[ ! -f "$SEARCH_DB" ]]; then
  echo "  Search DB not found at $SEARCH_DB — skipping (created on next dashboard start)"
else
  # Add sprite column if missing
  sqlite3 "$SEARCH_DB" "ALTER TABLE session_meta ADD COLUMN sprite TEXT" 2>/dev/null || true

  synced=0
  for rf in "$RUNNING_DIR"/*.json; do
    [[ -f "$rf" ]] || continue

    sid=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
    ccd=$(jq -r '.ccd_session_id // empty' "$rf" 2>/dev/null)
    sprite=$(jq -r '.sprite // empty' "$rf" 2>/dev/null)

    [[ -z "$sprite" ]] && continue

    # Update under both session_id and ccd_session_id
    if [[ -n "$sid" ]]; then
      sqlite3 "$SEARCH_DB" "UPDATE session_meta SET sprite = '${sprite//\'/\'\'}' WHERE session_id = '${sid//\'/\'\'}' AND (sprite IS NULL OR sprite = '')" 2>/dev/null || true
    fi
    if [[ -n "$ccd" && "$ccd" != "$sid" ]]; then
      sqlite3 "$SEARCH_DB" "UPDATE session_meta SET sprite = '${sprite//\'/\'\'}' WHERE session_id = '${ccd//\'/\'\'}' AND (sprite IS NULL OR sprite = '')" 2>/dev/null || true
    fi
    synced=$((synced + 1))
  done

  total=$(sqlite3 "$SEARCH_DB" "SELECT COUNT(*) FROM session_meta" 2>/dev/null || echo "?")
  has_sprite=$(sqlite3 "$SEARCH_DB" "SELECT COUNT(*) FROM session_meta WHERE sprite IS NOT NULL AND sprite != ''" 2>/dev/null || echo "?")
  echo "  Synced $synced running agents to search DB"
  echo "  Search DB: $has_sprite/$total sessions have sprites"
  echo "  (Historical dead sessions without sprites will show as pokeball in PC Box)"
fi

echo ""
echo "=== Migration complete ==="
echo ""
echo "Next steps:"
echo "  1. pokegent dashboard build   # rebuild and restart"
echo "  2. Hard refresh the dashboard  # Cmd+Shift+R"
