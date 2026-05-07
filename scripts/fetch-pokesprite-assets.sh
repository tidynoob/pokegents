#!/usr/bin/env bash
# Fetch Pokémon sprite assets from msikma/pokesprite for local builds/releases.
# We intentionally do not commit these third-party sprites to this repository.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${POKEGENTS_SPRITES_DIR:-$ROOT/dashboard/web/public/sprites}"
REF="${POKESPRITE_REF:-master}"
URL="${POKESPRITE_TARBALL_URL:-https://github.com/msikma/pokesprite/archive/refs/heads/${REF}.tar.gz}"
TMPDIR="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to fetch PokeSprite assets" >&2
  exit 1
fi

mkdir -p "$DEST"

echo "Fetching PokeSprite assets from $URL"
curl -fsSL "$URL" -o "$TMPDIR/pokesprite.tar.gz"
tar -xzf "$TMPDIR/pokesprite.tar.gz" -C "$TMPDIR"
SRC_ROOT="$(find "$TMPDIR" -maxdepth 1 -type d -name 'pokesprite-*' | head -1)"
if [[ -z "$SRC_ROOT" || ! -d "$SRC_ROOT/pokemon-gen8/regular" ]]; then
  echo "Could not find pokemon-gen8/regular in PokeSprite archive" >&2
  exit 1
fi

cp "$SRC_ROOT"/pokemon-gen8/regular/*.png "$DEST"/

# Dashboard-specific aliases used by collapse/message animations.
if [[ -f "$SRC_ROOT/items/ball/poke.png" ]]; then
  cp "$SRC_ROOT/items/ball/poke.png" "$DEST/pokeball.png"
fi
if [[ -f "$SRC_ROOT/items/mail/air-mail.png" ]]; then
  cp "$SRC_ROOT/items/mail/air-mail.png" "$DEST/_air-mail.png"
  cp "$SRC_ROOT/items/mail/air-mail.png" "$DEST/_letter.png"
fi
if [[ -f "$SRC_ROOT/items/mail/heart-mail.png" ]]; then
  cp "$SRC_ROOT/items/mail/heart-mail.png" "$DEST/_heart-mail.png"
fi

cat > "$DEST/POKESPRITE_NOTICE.txt" <<NOTICE
Sprites fetched from https://github.com/msikma/pokesprite at ref: $REF
These third-party assets are downloaded for local use/builds and are not committed to the Pokegents repository.
Review the upstream repository's license and attribution requirements before redistribution.
NOTICE

count="$(find "$DEST" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')"
echo "✓ Installed $count sprite PNGs into $DEST"
