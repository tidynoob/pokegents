_pokegent_save_history() {
  local session_id="$1" history_file="$2"
  local timestamp=$(date "+%Y-%m-%d %H:%M")

  # Extract first user message as summary (jq, no python3)
  local summary=""
  local session_file=$(find "$HOME/.claude/projects" -name "${session_id}.jsonl" -maxdepth 2 2>/dev/null | head -1)
  if [[ -n "$session_file" && -f "$session_file" ]]; then
    summary=$(head -100 "$session_file" | while IFS= read -r line; do
      echo "$line" | jq -r '
        select(.type == "user") |
        .message | if type == "object" then
          .content | if type == "array" then .[0].text // "" else . end
        else tostring end
      ' 2>/dev/null
    done | head -1 | head -c 80)
  fi
  [[ -z "$summary" ]] && summary="(no summary)"

  local new_entry=$(jq -n \
    --arg sid "$session_id" \
    --arg ts "$timestamp" \
    --arg sum "$summary" \
    '{session_id: $sid, timestamp: $ts, summary: $sum}')

  if [[ -f "$history_file" ]]; then
    jq --argjson entry "$new_entry" '[$entry] + . | .[0:5]' "$history_file" > "${history_file}.tmp" \
      && mv "${history_file}.tmp" "$history_file"
  else
    echo "[$new_entry]" | jq '.' > "$history_file"
  fi
}
