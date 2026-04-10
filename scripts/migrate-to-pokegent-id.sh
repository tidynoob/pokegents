#!/bin/bash
# migrate-to-pokegent-id.sh — One-time migration for the pokegent_id refactor
#
# Migrates all pokegent data stores from session_id keys to pokegent_id keys.
# Also backfills sprites into running files (preserving what the old dashboard showed).
#
# Run AFTER pulling the pokegent_id refactor and BEFORE restarting the dashboard.
#
# Usage:
#   ./scripts/migrate-to-pokegent-id.sh
#   pokegent dashboard build
#   # Hard refresh browser (Cmd+Shift+R)

set -euo pipefail

POKEGENTS_DATA="${POKEGENTS_DATA:-$HOME/.pokegents}"
RUNNING_DIR="$POKEGENTS_DATA/running"
STATUS_DIR="$POKEGENTS_DATA/status"
SEARCH_DB="$POKEGENTS_DATA/search.db"
OVERRIDES_FILE="$POKEGENTS_DATA/sprite-overrides.json"
DYN_PROFILE_DIR="$HOME/Library/Application Support/iTerm2/DynamicProfiles"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SPRITE_LIST="$SCRIPT_DIR/../dashboard/web/public/sprites/_base_sprites.txt"

echo "=== Pokegent ID Migration ==="
echo "Data dir: $POKEGENTS_DATA"
echo ""

# ── Build session_id → pokegent_id mapping from running files ──

declare -A ID_MAP        # session_id → pokegent_id
declare -A PROFILE_MAP   # session_id → profile name
declare -A SPRITE_MAP    # pokegent_id → sprite

# Load sprite overrides (user-picked sprites from old system)
OVERRIDES="{}"
if [[ -f "$OVERRIDES_FILE" ]]; then
  OVERRIDES=$(cat "$OVERRIDES_FILE")
  echo "Found sprite-overrides.json"
fi

# JS-compatible hash (matches what the old dashboard frontend computed)
hash_sprite() {
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
" "$1"
}

echo "=== Step 1: Scan running files and build ID mapping ==="

for rf in "$RUNNING_DIR"/*.json; do
  [[ -f "$rf" ]] || continue

  sid=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
  ccd=$(jq -r '.ccd_session_id // empty' "$rf" 2>/dev/null)
  pgid=$(jq -r '.pokegent_id // empty' "$rf" 2>/dev/null)
  profile=$(jq -r '.profile // empty' "$rf" 2>/dev/null)
  name=$(jq -r '.display_name // "unknown"' "$rf" 2>/dev/null)

  # Determine pokegent_id: existing > ccd_session_id > session_id
  if [[ -n "$pgid" ]]; then
    pokegent_id="$pgid"
  elif [[ -n "$ccd" ]]; then
    pokegent_id="$ccd"
  elif [[ -n "$sid" ]]; then
    pokegent_id="$sid"
  else
    echo "  SKIP: $rf (no IDs found)"
    continue
  fi

  # Map session_id → pokegent_id (for remapping other stores)
  if [[ -n "$sid" && "$sid" != "$pokegent_id" ]]; then
    ID_MAP["$sid"]="$pokegent_id"
  fi
  # Also map ccd_session_id if different
  if [[ -n "$ccd" && "$ccd" != "$pokegent_id" && "$ccd" != "$sid" ]]; then
    ID_MAP["$ccd"]="$pokegent_id"
  fi
  PROFILE_MAP["$sid"]="$profile"

  # Determine sprite (preserving what old dashboard showed)
  existing_sprite=$(jq -r '.sprite // empty' "$rf" 2>/dev/null)
  if [[ -n "$existing_sprite" ]]; then
    sprite="$existing_sprite"
  else
    # Priority 1: sprite-overrides.json
    sprite=""
    if [[ -n "$ccd" ]]; then
      sprite=$(echo "$OVERRIDES" | jq -r --arg id "$ccd" '.[$id] // empty' 2>/dev/null)
    fi
    if [[ -z "$sprite" && -n "$sid" ]]; then
      sprite=$(echo "$OVERRIDES" | jq -r --arg id "$sid" '.[$id] // empty' 2>/dev/null)
    fi
    # Priority 2: hash of ccd_session_id (what old dashboard computed)
    if [[ -z "$sprite" && -n "$ccd" ]]; then
      sprite=$(hash_sprite "$ccd")
    fi
    # Priority 3: hash of session_id
    if [[ -z "$sprite" && -n "$sid" ]]; then
      sprite=$(hash_sprite "$sid")
    fi
  fi
  SPRITE_MAP["$pokegent_id"]="$sprite"

  echo "  $name: sid=${sid:0:8} → pokegent_id=${pokegent_id:0:8} sprite=$sprite"
done

echo "  Mapped ${#ID_MAP[@]} session_id → pokegent_id entries"
echo ""

# ── Step 2: Patch running files (add pokegent_id + sprite, rename) ──

echo "=== Step 2: Patch and rename running files ==="
patched=0

for rf in "$RUNNING_DIR"/*.json; do
  [[ -f "$rf" ]] || continue

  sid=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
  ccd=$(jq -r '.ccd_session_id // empty' "$rf" 2>/dev/null)
  pgid=$(jq -r '.pokegent_id // empty' "$rf" 2>/dev/null)
  profile=$(jq -r '.profile // empty' "$rf" 2>/dev/null)
  name=$(jq -r '.display_name // "unknown"' "$rf" 2>/dev/null)
  existing_sprite=$(jq -r '.sprite // empty' "$rf" 2>/dev/null)

  pokegent_id="${pgid:-${ccd:-$sid}}"
  sprite="${existing_sprite:-${SPRITE_MAP[$pokegent_id]:-}}"

  # Patch fields
  needs_patch=false
  patch_expr="."
  if [[ -z "$pgid" ]]; then
    patch_expr="$patch_expr | .pokegent_id = \"$pokegent_id\""
    needs_patch=true
  fi
  if [[ -z "$existing_sprite" && -n "$sprite" ]]; then
    patch_expr="$patch_expr | .sprite = \"$sprite\""
    needs_patch=true
  fi

  if [[ "$needs_patch" == "true" ]]; then
    jq "$patch_expr" "$rf" > "${rf}.tmp" && mv "${rf}.tmp" "$rf"
  fi

  # Rename file to {profile}-{pokegent_id}.json
  expected_name="${profile}-${pokegent_id}.json"
  current_name=$(basename "$rf")
  if [[ "$current_name" != "$expected_name" ]]; then
    new_path="$RUNNING_DIR/$expected_name"
    if [[ -f "$new_path" && "$new_path" != "$rf" ]]; then
      echo "  CONFLICT: $name — target $expected_name already exists, skipping rename"
    else
      mv "$rf" "$new_path"
      echo "  Renamed: $current_name → $expected_name"
      patched=$((patched + 1))
    fi
  elif [[ "$needs_patch" == "true" ]]; then
    echo "  Patched: $name (fields updated, filename OK)"
    patched=$((patched + 1))
  fi
done

echo "  $patched running files updated"
echo ""

# ── Step 3: Rename status files ──

echo "=== Step 3: Rename status files ==="
renamed=0

for sf in "$STATUS_DIR"/*.json; do
  [[ -f "$sf" ]] || continue
  fname=$(basename "$sf" .json)

  # Check if this session_id has a pokegent_id mapping
  if [[ -n "${ID_MAP[$fname]:-}" ]]; then
    new_name="${ID_MAP[$fname]}.json"
    new_path="$STATUS_DIR/$new_name"
    if [[ -f "$new_path" && "$new_path" != "$sf" ]]; then
      echo "  CONFLICT: $new_name already exists, skipping"
    else
      mv "$sf" "$new_path"
      echo "  Renamed: $fname.json → $new_name"
      renamed=$((renamed + 1))
    fi
  fi
done

echo "  $renamed status files renamed"
echo ""

# ── Step 4: Remap grid-layout.json ──

echo "=== Step 4: Remap grid-layout.json ==="
GRID_FILE="$POKEGENTS_DATA/grid-layout.json"

if [[ -f "$GRID_FILE" ]]; then
  python3 -c "
import json, sys

id_map = json.loads(sys.argv[1])
with open('$GRID_FILE') as f:
    data = json.load(f)

layouts = data.get('layouts', {})
new_layouts = {}
remapped = 0
for key, val in layouts.items():
    new_key = id_map.get(key, key)
    if new_key != key:
        remapped += 1
    new_layouts[new_key] = val
data['layouts'] = new_layouts

with open('$GRID_FILE', 'w') as f:
    json.dump(data, f, indent=2)
print(f'  Remapped {remapped} layout entries')
" "$(python3 -c "import json; print(json.dumps({k:v for k,v in $(declare -p ID_MAP | sed "s/declare -A ID_MAP=//" | sed "s/\[/\"/g" | sed "s/\]=/\":\"/g" | sed "s/ /\",\"/g" | sed 's/(/{/;s/)/}/' | sed 's/""/"/g' | sed 's/""$/"/').items()}))" 2>/dev/null || echo "{}")"
else
  echo "  No grid-layout.json found"
fi
echo ""

# ── Step 5: Remap name-overrides.json ──

echo "=== Step 5: Remap name-overrides.json ==="
NAME_FILE="$POKEGENTS_DATA/name-overrides.json"

if [[ -f "$NAME_FILE" ]]; then
  python3 << PYEOF
import json

with open('$NAME_FILE') as f:
    data = json.load(f)

id_map = {}
$(for k in "${!ID_MAP[@]}"; do echo "id_map['$k'] = '${ID_MAP[$k]}'"; done)

new_data = {}
remapped = 0
for key, val in data.items():
    new_key = id_map.get(key, key)
    if new_key != key:
        remapped += 1
    new_data[new_key] = val

with open('$NAME_FILE', 'w') as f:
    json.dump(new_data, f, indent=2)
print(f'  Remapped {remapped} name override entries')
PYEOF
else
  echo "  No name-overrides.json found"
fi
echo ""

# ── Step 6: Remap agent-order.json ──

echo "=== Step 6: Remap agent-order.json ==="
ORDER_FILE="$POKEGENTS_DATA/agent-order.json"

if [[ -f "$ORDER_FILE" ]]; then
  python3 << PYEOF
import json

with open('$ORDER_FILE') as f:
    data = json.load(f)

id_map = {}
$(for k in "${!ID_MAP[@]}"; do echo "id_map['$k'] = '${ID_MAP[$k]}'"; done)

new_data = [id_map.get(x, x) for x in data]
remapped = sum(1 for old, new in zip(data, new_data) if old != new)

with open('$ORDER_FILE', 'w') as f:
    json.dump(new_data, f, indent=2)
print(f'  Remapped {remapped} agent order entries')
PYEOF
else
  echo "  No agent-order.json found"
fi
echo ""

# ── Step 7: Update session-id-map.json ──

echo "=== Step 7: Update session-id-map.json ==="
SID_MAP_FILE="$POKEGENTS_DATA/session-id-map.json"

if [[ -f "$SID_MAP_FILE" ]]; then
  python3 << PYEOF
import json

with open('$SID_MAP_FILE') as f:
    data = json.load(f)

# Add pokegent_id → session_id entries alongside existing ccd → session_id entries
id_map = {}
$(for k in "${!ID_MAP[@]}"; do echo "id_map['$k'] = '${ID_MAP[$k]}'"; done)

added = 0
for old_key, new_key in id_map.items():
    if old_key in data and new_key not in data:
        data[new_key] = data[old_key]
        added += 1

with open('$SID_MAP_FILE', 'w') as f:
    json.dump(data, f, indent=2)
print(f'  Added {added} pokegent_id entries')
PYEOF
else
  echo "  No session-id-map.json found"
fi
echo ""

# ── Step 8: Backfill search DB ──

echo "=== Step 8: Backfill search DB ==="

if [[ -f "$SEARCH_DB" ]]; then
  # Add columns if missing
  sqlite3 "$SEARCH_DB" "ALTER TABLE session_meta ADD COLUMN sprite TEXT" 2>/dev/null || true
  sqlite3 "$SEARCH_DB" "ALTER TABLE session_meta ADD COLUMN pokegent_id TEXT" 2>/dev/null || true

  synced=0
  for rf in "$RUNNING_DIR"/*.json; do
    [[ -f "$rf" ]] || continue
    sid=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
    ccd=$(jq -r '.ccd_session_id // empty' "$rf" 2>/dev/null)
    pgid=$(jq -r '.pokegent_id // empty' "$rf" 2>/dev/null)
    sprite=$(jq -r '.sprite // empty' "$rf" 2>/dev/null)

    for id in "$sid" "$ccd" "$pgid"; do
      [[ -z "$id" ]] && continue
      if [[ -n "$pgid" ]]; then
        sqlite3 "$SEARCH_DB" "UPDATE session_meta SET pokegent_id = '${pgid//\'/\'\'}' WHERE session_id = '${id//\'/\'\'}'" 2>/dev/null || true
      fi
      if [[ -n "$sprite" ]]; then
        sqlite3 "$SEARCH_DB" "UPDATE session_meta SET sprite = '${sprite//\'/\'\'}' WHERE session_id = '${id//\'/\'\'}' AND (sprite IS NULL OR sprite = '')" 2>/dev/null || true
      fi
    done
    synced=$((synced + 1))
  done

  total=$(sqlite3 "$SEARCH_DB" "SELECT COUNT(*) FROM session_meta" 2>/dev/null || echo "?")
  has_pgid=$(sqlite3 "$SEARCH_DB" "SELECT COUNT(*) FROM session_meta WHERE pokegent_id IS NOT NULL AND pokegent_id != ''" 2>/dev/null || echo "?")
  has_sprite=$(sqlite3 "$SEARCH_DB" "SELECT COUNT(*) FROM session_meta WHERE sprite IS NOT NULL AND sprite != ''" 2>/dev/null || echo "?")
  echo "  Synced $synced agents"
  echo "  Search DB: $has_pgid/$total have pokegent_id, $has_sprite/$total have sprites"
else
  echo "  No search.db found (created on next dashboard start)"
fi
echo ""

# ── Step 9: Rename iTerm2 Dynamic Profiles ──

echo "=== Step 9: Rename iTerm2 Dynamic Profiles ==="
renamed_dp=0

if [[ -d "$DYN_PROFILE_DIR" ]]; then
  for dp in "$DYN_PROFILE_DIR"/pokegents-session-*.json; do
    [[ -f "$dp" ]] || continue
    fname=$(basename "$dp" .json)
    old_id="${fname#pokegents-session-}"

    if [[ -n "${ID_MAP[$old_id]:-}" ]]; then
      new_id="${ID_MAP[$old_id]}"
      new_path="$DYN_PROFILE_DIR/pokegents-session-${new_id}.json"
      if [[ -f "$new_path" && "$new_path" != "$dp" ]]; then
        echo "  CONFLICT: pokegents-session-${new_id}.json exists, skipping"
      else
        mv "$dp" "$new_path"
        echo "  Renamed: $old_id → $new_id"
        renamed_dp=$((renamed_dp + 1))
      fi
    fi
  done
  echo "  $renamed_dp Dynamic Profiles renamed"
else
  echo "  No iTerm2 Dynamic Profiles directory found (non-macOS or iTerm2 not installed)"
fi
echo ""

# ── Done ──

echo "=== Migration complete ==="
echo ""
echo "Next steps:"
echo "  1. pokegent dashboard build   # rebuild and restart"
echo "  2. Hard refresh browser        # Cmd+Shift+R"
echo ""
echo "Notes:"
echo "  - Historical PC Box sessions without sprites show as pokeball"
echo "  - Active agents preserve their current dashboard sprites"
echo "  - Grid positions, names, and agent order are preserved"
echo "  - Old sprite-overrides.json can be deleted after verifying"
