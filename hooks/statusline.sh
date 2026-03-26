#!/bin/bash
# ccd status line — shows profile name with profile color in Claude's status bar
# NOTE: No set -e. Same resilience rules as status-update.sh.

input=$(cat)

CCD_DATA="${CCD_DATA:-$HOME/.ccsession}"

if [[ -n "$CCD_PROFILE_NAME" ]]; then
  profile_file="$CCD_DATA/profiles/${CCD_PROFILE_NAME}.json"

  if [[ -f "$profile_file" ]]; then
    emoji=$(jq -r '.emoji // ""' "$profile_file" 2>/dev/null || echo "")
    title=$(jq -r '.title // ""' "$profile_file" 2>/dev/null || echo "$CCD_PROFILE_NAME")
    r=$(jq -r '.color[0] // 128' "$profile_file" 2>/dev/null || echo "128")
    g=$(jq -r '.color[1] // 128' "$profile_file" 2>/dev/null || echo "128")
    b=$(jq -r '.color[2] // 128' "$profile_file" 2>/dev/null || echo "128")
    printf "\033[38;2;%d;%d;%dm%s %s\033[0m" "$r" "$g" "$b" "$emoji" "$title"
  else
    echo "$CCD_PROFILE_NAME"
  fi
else
  # Fallback: show model name
  model=$(echo "$input" | jq -r '.model.display_name // "Claude"' 2>/dev/null || echo "Claude")
  echo "$model"
fi
