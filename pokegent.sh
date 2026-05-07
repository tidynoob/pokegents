#!/usr/bin/env zsh
# pokegents — Claude Code Agent Orchestration Platform
# Internal CLI implementation. Users should normally run the installed
# `pokegents` shim rather than sourcing this file from a shell profile.

# Resolve install directory at source time
POKEGENTS_ROOT="${${(%):-%x}:A:h}"
POKEGENTS_DATA="${POKEGENTS_DATA:-$HOME/.pokegents}"

# Platform detection — iTerm2 features are optional
POKEGENTS_HAS_ITERM=false
[[ "$TERM_PROGRAM" == "iTerm.app" ]] && POKEGENTS_HAS_ITERM=true
POKEGENTS_IS_MACOS=false
[[ "$OSTYPE" == darwin* ]] && POKEGENTS_IS_MACOS=true

_pokegent_config_string() {
  local config_path="$1"
  local key="$2"
  local default_value="${3:-}"
  python3 - "$config_path" "$key" "$default_value" <<'PY'
import json, sys
path, key, default = sys.argv[1:4]
try:
    with open(path) as f:
        value = json.load(f).get(key, default)
    print(value if isinstance(value, str) and value else default)
except Exception:
    print(default)
PY
}

_pokegent_shell_quote() {
  python3 -c 'import shlex, sys; print(shlex.quote(sys.argv[1]))' "$1"
}

_pokegent_run_open_command() {
  local command="$1"
  local target="$2"
  [[ -z "$command" ]] && return 1
  local quoted_target
  quoted_target="$(_pokegent_shell_quote "$target")"
  if [[ "$command" == *"{target}"* || "$command" == *"{url}"* || "$command" == *"{path}"* || "$command" == *"{file}"* ]]; then
    command="${command//\{target\}/$quoted_target}"
    command="${command//\{url\}/$quoted_target}"
    command="${command//\{path\}/$quoted_target}"
    command="${command//\{file\}/$quoted_target}"
  else
    command="$command $quoted_target"
  fi
  eval "$command"
}

# Source helper modules
for _lib in "$POKEGENTS_ROOT"/lib/*.sh; do
  [[ -f "$_lib" ]] && source "$_lib"
done

pokegent() {
  local PROFILES_DIR="$POKEGENTS_DATA/profiles"
  local PROJECTS_DIR="$POKEGENTS_DATA/projects"
  local ROLES_DIR="$POKEGENTS_DATA/roles"
  local HISTORY_DIR="$POKEGENTS_DATA/history"
  local RUNNING_DIR="$POKEGENTS_DATA/running"
  local POKEGENTS_CONFIG="$POKEGENTS_DATA/config.json"
  mkdir -p "$HISTORY_DIR" "$RUNNING_DIR"

  # Load config (single source of truth for port, defaults, etc.)
  local POKEGENTS_PORT=$(jq -r '.port // 7834' "$POKEGENTS_CONFIG" 2>/dev/null || echo "7834")
  local POKEGENTS_DEFAULT_PROFILE=$(jq -r '.default_profile // "personal"' "$POKEGENTS_CONFIG" 2>/dev/null || echo "personal")
  local POKEGENTS_SKIP_PERMISSIONS=$(jq -r '.skip_permissions // false' "$POKEGENTS_CONFIG" 2>/dev/null || echo "false")
  local POKEGENTS_ITERM_RESTORE=$(jq -r '.iterm2_restore_profile // "Default"' "$POKEGENTS_CONFIG" 2>/dev/null || echo "Default")
  export POKEGENTS_DASHBOARD_URL="http://localhost:$POKEGENTS_PORT"

  # Resolve a project name by alias. Checks each project's "aliases" array.
  # Prints the canonical project filename (without .json) if found, empty otherwise.
  _pokegent_resolve_project_alias() {
    local _alias="$1"
    for _pf in "$PROJECTS_DIR"/*.json(N); do
      local _match=$(jq -r --arg a "$_alias" '(.aliases // [])[] | select(. == $a)' "$_pf" 2>/dev/null)
      if [[ -n "$_match" ]]; then
        basename "$_pf" .json
        return 0
      fi
    done
    return 1
  }

  # Search JSONL custom-titles for a term. Prints "session_id\ttitle" lines.
  # Args: $1=search_term, $2+=directories to search
  _pokegent_search_jsonl_titles() {
    local _term="$1"; shift
    python3 -c "
import json, os, sys, glob
term = sys.argv[1].lower()
seen = set()
for d in sys.argv[2:]:
    for f in sorted(glob.glob(os.path.join(d, '*.jsonl')), key=os.path.getmtime, reverse=True):
        sid = os.path.basename(f).replace('.jsonl', '')
        if sid in seen:
            continue
        seen.add(sid)
        last_title = ''
        try:
            with open(f) as fh:
                for line in fh:
                    try:
                        obj = json.loads(line)
                        if obj.get('type') == 'custom-title':
                            last_title = obj.get('customTitle', '')
                    except: pass
        except: continue
        if last_title and term in last_title.lower():
            print(f'{sid}\t{last_title}')
" "$_term" "$@" 2>/dev/null
  }

  # Search sessions by name (case-insensitive substring match).
  # Prints tab-separated "session_id\ttitle" lines to stdout.
  # Args: $1=search_term, $2=cwd (for project dir scoping)
  _pokegent_search_by_name() {
    local _term="$1" _cwd="$2"

    # 1. Search name-overrides.json (dashboard renames — highest priority)
    local _overrides_file="$POKEGENTS_DATA/name-overrides.json"
    if [[ -f "$_overrides_file" ]]; then
      local _override_results=$(jq -r --arg term "$_term" '
        to_entries[] | select(.value | test($term; "i")) | "\(.key)\t\(.value)"
      ' "$_overrides_file" 2>/dev/null)
      if [[ -n "$_override_results" ]]; then
        echo "$_override_results"
        return 0
      fi
    fi

    # 2. Search JSONL custom-titles (scoped to project dir first, widen if no matches)
    local _proj_dir_base="$(echo "$_cwd" | sed 's|/|-|g; s|^|/|; s|^/||; s|_|-|g')"
    local _search_dirs=()
    for pdir in "$HOME/.claude/projects/"${_proj_dir_base}*(N/); do
      _search_dirs+=("$pdir")
    done

    local _title_results=""
    if [[ ${#_search_dirs[@]} -gt 0 ]]; then
      _title_results=$(_pokegent_search_jsonl_titles "$_term" "${_search_dirs[@]}")
    fi
    # Widen to all project dirs if scoped search found nothing
    if [[ -z "$_title_results" ]]; then
      _search_dirs=()
      for pdir in "$HOME/.claude/projects/"*(N/); do
        _search_dirs+=("$pdir")
      done
      _title_results=$(_pokegent_search_jsonl_titles "$_term" "${_search_dirs[@]}")
    fi
    [[ -n "$_title_results" ]] && echo "$_title_results"
  }

  # Resolve name search results to a single session ID.
  # Sets resume_session_id on success. Returns 1 on failure (0 matches or ambiguous).
  # Args: $1=search_term, $2=cwd
  _pokegent_resolve_name() {
    local _term="$1" _cwd="$2"
    local _match_ids=() _match_labels=()

    while IFS=$'\t' read -r _sid _label; do
      [[ -n "$_sid" ]] && _match_ids+=("$_sid") && _match_labels+=("$_label")
    done < <(_pokegent_search_by_name "$_term" "$_cwd")

    local _unique_ids=("${(@u)_match_ids}")
    if [[ ${#_unique_ids[@]} -eq 0 ]]; then
      echo "No session found with name matching '$_term'"
      return 1
    elif [[ ${#_unique_ids[@]} -eq 1 ]]; then
      echo "Matched session: ${_match_labels[1]:-${_unique_ids[1]}} (${_unique_ids[1]:0:8})"
      resume_session_id="${_unique_ids[1]}"
      return 0
    else
      echo "Multiple sessions match '$_term':"
      local _shown=()
      for i in {1..${#_match_ids[@]}}; do
        if (( ! ${_shown[(Ie)${_match_ids[$i]}]} )); then
          echo "  ${_match_ids[$i]:0:8}  ${_match_labels[$i]:-${_match_ids[$i]}}"
          _shown+=("${_match_ids[$i]}")
        fi
      done
      echo "Use a session ID prefix to disambiguate."
      return 1
    fi
  }

  # Clean up stale running session files
  for rf in "$RUNNING_DIR"/*.json(N); do
    local rf_claude_pid=$(jq -r '.claude_pid // empty' "$rf" 2>/dev/null)
    local rf_pid=$(jq -r '.pid // empty' "$rf" 2>/dev/null)
    local rf_sid=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
    local is_stale=true

    # Check 1: Claude's PID (most reliable, if available)
    if [[ -n "$rf_claude_pid" ]] && kill -0 "$rf_claude_pid" 2>/dev/null; then
      is_stale=false
    fi

    # Check 2: Claude's session registry (authoritative fallback)
    if [[ "$is_stale" == "true" && -n "$rf_sid" ]]; then
      for csf in "$HOME/.claude/sessions"/*.json(N); do
        local cs_sid=$(jq -r '.sessionId // empty' "$csf" 2>/dev/null)
        local cs_pid=$(jq -r '.pid // empty' "$csf" 2>/dev/null)
        if [[ "$cs_sid" == "$rf_sid" ]] && [[ -n "$cs_pid" ]] && kill -0 "$cs_pid" 2>/dev/null; then
          is_stale=false
          break
        fi
      done
    fi

    # Check 3: Shell PID fallback
    if [[ "$is_stale" == "true" && -n "$rf_pid" ]] && kill -0 "$rf_pid" 2>/dev/null; then
      is_stale=false
    fi

    [[ "$is_stale" == "true" ]] && rm -f "$rf"
  done

  # -h / --help
  if [[ "$1" == "-h" || "$1" == "--help" || "$1" == "help" ]]; then
    cat <<'HELP'
Usage: pokegent [target] [options]
       pokegents [target] [options]

Targets:
  role@project        Launch a role in a project          (implementer@app)
  @project            Launch a project with no role       (@app)
  role@               Launch a role in the default project
  project             Launch a project by name or alias
  role                Launch a role in the default project

Commands:
  ls                  List projects and roles
  projects            List projects
  roles               List roles
  edit project NAME   Edit/create a project config
  edit role NAME      Edit/create a role config
  dashboard           Open the dashboard
  dashboard restart   Restart dashboard server
  dashboard build     Rebuild dashboard, then restart server
  doctor              Check install health

Options:
  -r, --resume [ID]   Resume session; ID can be a prefix
  -c                  Alias for --resume
  -w NAME             Launch in a git worktree
  --                  Pass remaining args through to Claude

Examples:
  pokegent
  pokegent implementer@app
  pokegent @app -r
  pokegent reviewer@ -w review-auth
  pokegent dashboard build
HELP
    return 0
  fi

  # ls / projects / roles
  if [[ "$1" == "ls" ]]; then
    _pokegent_list_all
    return 0
  fi
  if [[ "$1" == "projects" ]]; then
    _pokegent_list_projects
    return 0
  fi
  if [[ "$1" == "roles" ]]; then
    _pokegent_list_roles
    return 0
  fi

  # dashboard
  if [[ "$1" == "dashboard" ]]; then
    local dashboard_bin="$POKEGENTS_ROOT/dashboard/pokegents-dashboard"
    case "${2:-open}" in
      start)
        if [[ ! -f "$dashboard_bin" ]]; then
          echo "Dashboard not built. Run: pokegent dashboard build"
          return 1
        fi
        POKEGENTS_DATA="$POKEGENTS_DATA" "$dashboard_bin" serve &
        echo "Dashboard started at http://localhost:$POKEGENTS_PORT"
        ;;
      stop)
        _pokegent_kill_dashboard
        echo "Dashboard stopped"
        ;;
      restart)
        _pokegent_kill_dashboard
        sleep 0.5
        POKEGENTS_DATA="$POKEGENTS_DATA" "$dashboard_bin" serve &>/dev/null &
        disown
        echo "Dashboard restarted at http://localhost:$POKEGENTS_PORT"
        ;;
      build)
        echo "=== Dashboard Build ==="
        echo ""
        # Build Go server
        echo "Building server..."
        if (cd "$POKEGENTS_ROOT/dashboard" && CGO_CFLAGS="-DSQLITE_ENABLE_FTS5" go build -o pokegents-dashboard . 2>&1); then
          echo "  ✓ Server built"
        else
          echo "  ✗ Server build FAILED"
          return 1
        fi
        # Build frontend
        echo "Building frontend..."
        if (cd "$POKEGENTS_ROOT/dashboard/web" && npm run build 2>&1 | tail -3); then
          echo "  ✓ Frontend built"
        else
          echo "  ✗ Frontend build FAILED"
          return 1
        fi
        # Restart server
        echo ""
        echo "Restarting dashboard..."
        _pokegent_kill_dashboard
        sleep 0.5
        POKEGENTS_DATA="$POKEGENTS_DATA" "$dashboard_bin" serve &>/dev/null &
        disown
        echo "  ✓ Dashboard running at http://localhost:$POKEGENTS_PORT"
        echo ""
        echo "=== Build complete ==="
        ;;
      open|"")
        local url="http://localhost:$POKEGENTS_PORT"
        local browser_open_command
        browser_open_command="$(_pokegent_config_string "$POKEGENTS_CONFIG" browser_open_command "")"
        if [[ -n "$browser_open_command" ]]; then
          _pokegent_run_open_command "$browser_open_command" "$url" || echo "$url"
        elif [[ "$OSTYPE" == darwin* ]]; then
          local chrome_profile="$HOME/.pokegents-dashboard-chrome"
          if [[ -d "/Applications/Google Chrome.app" || -d "$HOME/Applications/Google Chrome.app" ]]; then
            open -na "Google Chrome" --args --app="$url" --user-data-dir="$chrome_profile"
          else
            open "$url"
          fi
        else
          python3 -m webbrowser "$url" >/dev/null 2>&1 || echo "$url"
        fi
        ;;
    esac
    return 0
  fi

  # doctor — verify installation health
  if [[ "$1" == "doctor" ]]; then
    _pokegent_doctor
    return $?
  fi

  # reload — stop all sessions, rebuild dashboard, relaunch everything
  if [[ "$1" == "reload" ]]; then
    _pokegent_reload
    return $?
  fi

  # --resume / -r (no profile) — pass through to claude with optional session ID
  if [[ "$1" == "--resume" || "$1" == "-r" ]]; then
    if [[ -n "$2" && "$2" != -* ]]; then
      claude --resume "$2"
    else
      claude --resume
    fi
    return $?
  fi

  # No args → default project (or default_role@default_project)
  if [[ -z "$1" ]]; then
    local _default_project=$(jq -r '.default_project // empty' "$POKEGENTS_CONFIG" 2>/dev/null)
    local _default_role=$(jq -r '.default_role // empty' "$POKEGENTS_CONFIG" 2>/dev/null)
    if [[ -n "$_default_project" && -f "$PROJECTS_DIR/${_default_project}.json" ]]; then
      if [[ -n "$_default_role" && "$_default_role" != "null" && -f "$ROLES_DIR/${_default_role}.json" ]]; then
        set -- "${_default_role}@${_default_project}"
      else
        set -- "@${_default_project}"
      fi
    else
      set -- "$POKEGENTS_DEFAULT_PROFILE"
    fi
  fi

  # edit [project|role] <name>
  if [[ "$1" == "edit" ]]; then
    if [[ "$2" == "project" && -n "$3" ]]; then
      ${EDITOR:-nano} "$PROJECTS_DIR/${3}.json"
    elif [[ "$2" == "role" && -n "$3" ]]; then
      ${EDITOR:-nano} "$ROLES_DIR/${3}.json"
    else
      echo "Usage: pokegent edit [project|role] <name>"
      return 1
    fi
    return $?
  fi

  # ── Resolution: role@project, project, profile fallback, or role ────────
  local _arg="$1"
  shift

  local _role_name="" _project_name="" _profile_name=""
  local _role_file="" _project_file="" _profile_file=""
  local _resolved_mode=""  # "composed", "project", "profile", "role"

  if [[ "$_arg" == *"@"* ]]; then
    # Explicit role@project syntax
    _role_name="${_arg%%@*}"
    _project_name="${_arg#*@}"
    if [[ -n "$_role_name" ]]; then
      _role_file="$ROLES_DIR/${_role_name}.json"
      if [[ ! -f "$_role_file" ]]; then
        echo "Unknown role: $_role_name"
        echo "Run 'pokegent roles' to see available roles."
        return 1
      fi
    fi
    if [[ -n "$_project_name" ]]; then
      _project_file="$PROJECTS_DIR/${_project_name}.json"
      if [[ ! -f "$_project_file" ]]; then
        # Try alias resolution
        local _canonical=$(_pokegent_resolve_project_alias "$_project_name")
        if [[ -n "$_canonical" ]]; then
          _project_name="$_canonical"
          _project_file="$PROJECTS_DIR/${_project_name}.json"
        else
          echo "Unknown project: $_project_name"
          echo "Run 'pokegent projects' to see available projects."
          return 1
        fi
      fi
    else
      # role@ with no project — use default
      local _default_project=$(jq -r '.default_project // "personal"' "$POKEGENTS_CONFIG" 2>/dev/null || echo "personal")
      _project_name="$_default_project"
      _project_file="$PROJECTS_DIR/${_project_name}.json"
      if [[ ! -f "$_project_file" ]]; then
        echo "Error: default project '$_project_name' not found in $PROJECTS_DIR/"
        return 1
      fi
    fi
    _resolved_mode="composed"
  else
    # Resolution order: project > project alias > profile fallback > role
    if [[ -f "$PROJECTS_DIR/${_arg}.json" ]]; then
      _project_name="$_arg"
      _project_file="$PROJECTS_DIR/${_project_name}.json"
      _resolved_mode="project"
    elif _canonical=$(_pokegent_resolve_project_alias "$_arg") && [[ -n "$_canonical" ]]; then
      _project_name="$_canonical"
      _project_file="$PROJECTS_DIR/${_project_name}.json"
      _resolved_mode="project"
    elif [[ -f "$PROFILES_DIR/${_arg}.json" ]]; then
      _profile_name="$_arg"
      _profile_file="$PROFILES_DIR/${_profile_name}.json"
      _resolved_mode="profile"
    elif [[ -f "$ROLES_DIR/${_arg}.json" ]]; then
      _role_name="$_arg"
      _role_file="$ROLES_DIR/${_role_name}.json"
      # Role-only: use default project
      local _default_project=$(jq -r '.default_project // "personal"' "$POKEGENTS_CONFIG" 2>/dev/null || echo "personal")
      _project_name="$_default_project"
      _project_file="$PROJECTS_DIR/${_project_name}.json"
      if [[ ! -f "$_project_file" ]]; then
        echo "Error: default project '$_project_name' not found in $PROJECTS_DIR/"
        return 1
      fi
      _resolved_mode="composed"
    else
      echo "Unknown project or role: $_arg"
      echo "Run 'pokegent ls' to see available options."
      return 1
    fi
  fi

  # ── Read resolved fields ──────────────────────────────────────────────
  local profile_name="" title="" emoji="" r="" g="" b="" cwd="" system_prompt=""
  local _iterm2_profile="" _add_dirs_file="" _skip_perms_override=""
  local _model="" _effort=""

  case "$_resolved_mode" in
    composed|project)
      # Read project fields
      title=$(jq -r '.title' "$_project_file")
      r=$(jq -r '.color[0]' "$_project_file")
      g=$(jq -r '.color[1]' "$_project_file")
      b=$(jq -r '.color[2]' "$_project_file")
      cwd=$(jq -r '.cwd' "$_project_file")
      _iterm2_profile=$(jq -r '.iterm2_profile // empty' "$_project_file")
      _add_dirs_file="$_project_file"
      local _context_prompt=$(jq -r '.context_prompt // empty' "$_project_file")
      _model=$(jq -r '.model // empty' "$_project_file")
      _effort=$(jq -r '.effort // empty' "$_project_file")

      if [[ -n "$_role_file" && -f "$_role_file" ]]; then
        # Composed: role + project
        local _role_title=$(jq -r '.title' "$_role_file")
        emoji=$(jq -r '.emoji' "$_role_file")
        local _role_prompt=$(jq -r '.system_prompt // empty' "$_role_file")
        _skip_perms_override=$(jq -r '.skip_permissions // "unset"' "$_role_file" 2>/dev/null)
        local _role_model=$(jq -r '.model // empty' "$_role_file")
        local _role_effort=$(jq -r '.effort // empty' "$_role_file")
        [[ -n "$_role_model" ]] && _model="$_role_model"
        [[ -n "$_role_effort" ]] && _effort="$_role_effort"

        # Compose display name and system prompt
        title="${_role_title} — ${title}"
        profile_name="${_role_name}@${_project_name}"

        # Prompt order: project context first, role instructions second
        if [[ -n "$_context_prompt" && -n "$_role_prompt" ]]; then
          system_prompt="${_context_prompt}

${_role_prompt}"
        elif [[ -n "$_role_prompt" ]]; then
          system_prompt="$_role_prompt"
        elif [[ -n "$_context_prompt" ]]; then
          system_prompt="$_context_prompt"
        fi
      else
        # Project-only (no role)
        emoji=$(jq -r '.emoji // "📁"' "$_project_file")
        profile_name="$_project_name"
        system_prompt="$_context_prompt"
      fi
      ;;
    profile)
      # Read compatibility profile
      title=$(jq -r '.title' "$_profile_file")
      emoji=$(jq -r '.emoji' "$_profile_file")
      r=$(jq -r '.color[0]' "$_profile_file")
      g=$(jq -r '.color[1]' "$_profile_file")
      b=$(jq -r '.color[2]' "$_profile_file")
      cwd=$(jq -r '.cwd' "$_profile_file")
      _iterm2_profile=$(jq -r '.iterm2_profile // empty' "$_profile_file")
      _add_dirs_file="$_profile_file"
      system_prompt=$(jq -r '.system_prompt // empty' "$_profile_file")
      _model=$(jq -r '.model // empty' "$_profile_file")
      _effort=$(jq -r '.effort // empty' "$_profile_file")
      profile_name="$_profile_name"
      ;;
  esac

  cwd="${cwd/#\~/$HOME}"  # expand ~ to $HOME (jq returns literal ~)
  local history_file="$HISTORY_DIR/${_project_name:-$profile_name}.json"

  # Parse flags from remaining args
  local worktree_name=""
  local continue_mode=false
  local resume_session_id=""
  local fork_session=false
  local task_group=""
  local inherited_pokegent_id=""
  local handoff_context_file=""
  local filtered_args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --continue|-c|--resume|-r)
        continue_mode=true
        if [[ -n "$2" && "$2" != -* ]]; then
          resume_session_id="$2"
          shift
        fi
        shift
        ;;
      --fork-session)
        fork_session=true
        filtered_args+=("$1")
        shift
        ;;
      --group|-g)
        if [[ -n "$2" && "$2" != -* ]]; then
          task_group="$2"
          shift 2
        else
          echo "Error: --group requires a name argument"
          return 1
        fi
        ;;
      --pokegent-id)
        if [[ -n "$2" && "$2" != -* ]]; then
          inherited_pokegent_id="$2"
          shift 2
        else
          echo "Error: --pokegent-id requires an ID argument"
          return 1
        fi
        ;;
      --handoff-context-file)
        if [[ -n "$2" ]]; then
          handoff_context_file="$2"
          shift 2
        else
          echo "Error: --handoff-context-file requires a path argument"
          return 1
        fi
        ;;
      --worktree|-w)
        if [[ -n "$2" ]]; then
          worktree_name="$2"
          shift 2
        else
          echo "Error: --worktree requires a name argument"
          return 1
        fi
        ;;
      *)
        filtered_args+=("$1")
        shift
        ;;
    esac
  done
  set -- "${filtered_args[@]}"

  # If resume_session_id doesn't look like a UUID/hex prefix, resolve by name search.
  # This lets users do: pokegent coord -r "Coordinator" instead of pokegent coord -r 0af628c3
  if [[ "$continue_mode" == "true" && -n "$resume_session_id" && ! "$resume_session_id" =~ ^[0-9a-fA-F-]+$ ]]; then
    _pokegent_resolve_name "$resume_session_id" "$cwd" || return 1
  fi

  # For resume-by-ID, resolve the display name. Priority:
  # 1. name-overrides.json (dashboard renames — highest priority, Claude can't overwrite)
  # 2. JSONL custom-title (Claude's built-in title)
  # 3. Profile default title
  local display_name="$title"
  if [[ "$continue_mode" == "true" && -n "$resume_session_id" ]]; then
    # Check name overrides first (prefix match)
    local _overrides_file="$POKEGENTS_DATA/name-overrides.json"
    if [[ -f "$_overrides_file" ]]; then
      local _override=$(jq -r --arg sid "$resume_session_id" '
        to_entries[] | select(.key | startswith($sid)) | .value
      ' "$_overrides_file" 2>/dev/null | head -1)
      if [[ -n "$_override" && "$_override" != "null" ]]; then
        display_name="$_override"
      fi
    fi

    # Fall back to JSONL custom-title if no override found
    if [[ "$display_name" == "$title" ]]; then
      local project_dir_base="$(echo "$cwd" | sed 's|/|-|g; s|^|/|; s|^/||; s|_|-|g')"
      for pdir in "$HOME/.claude/projects/"${project_dir_base}*(N/) "$HOME/.claude/projects/"*(N/); do
        for sf in "$pdir"/${resume_session_id}*.jsonl(N); do
          local _title=$(python3 -c "
import json, sys
last_title = ''
with open(sys.argv[1]) as f:
    for line in f:
        try:
            d = json.loads(line)
            if d.get('type') == 'custom-title':
                last_title = d.get('customTitle', '')
        except: pass
if last_title: print(last_title)
" "$sf" 2>/dev/null)
          if [[ -n "$_title" ]]; then
            display_name=$(echo "$_title" | sed 's/^[^a-zA-Z0-9]* *//')
          fi
          break 2
        done
      done
    fi
  fi
  if [[ -n "$worktree_name" ]]; then
    display_name="${display_name} ($worktree_name)"
  fi
  # Auto-name duplicates — but not when resuming (same session, not a clone)
  if [[ "$continue_mode" != "true" || "$fork_session" == "true" ]]; then
    local dup_count=0
    for rf in "$RUNNING_DIR"/*.json(N); do
      local rf_profile=$(jq -r '.profile' "$rf" 2>/dev/null)
      [[ "$rf_profile" == "$profile_name" ]] && ((dup_count++))
    done
    if [[ $dup_count -gt 0 ]]; then
      if [[ -n "$task_group" ]]; then
        # Use task group for semantic disambiguation: "Coordinator — Pokegents (auth-migration)"
        display_name="${display_name} (${task_group})"
      else
        # Number duplicates: "Coordinator — Pokegents (2)", "Coordinator — Pokegents (3)"
        display_name="${display_name} ($((dup_count + 1)))"
      fi
    fi
  fi

  # Terminal theming (iTerm2-specific — gracefully skipped on other terminals)
  if [[ "$POKEGENTS_HAS_ITERM" == "true" ]]; then
    if [[ -n "$_iterm2_profile" ]]; then
      printf "\033]1337;SetProfile=%s\a" "$_iterm2_profile"
    else
      echo -ne "\033]6;1;bg;red;brightness;$r\a"
      echo -ne "\033]6;1;bg;green;brightness;$g\a"
      echo -ne "\033]6;1;bg;blue;brightness;$b\a"
    fi
  fi

  # Set tab title (works on most terminals) and clear visible screen.
  # Use printf directly rather than `clear` — on macOS, /usr/bin/clear emits
  # \e[3J (erase scrollback) before \e[2J, which destroys terminal history.
  echo -ne "\033]0;$display_name\007"
  printf '\e[H\e[2J'

  # Generate session ID and pokegent_id (stable internal ID)
  local session_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  # pokegent_id is the stable internal ID. For new launches it matches session_id.
  # --pokegent-id flag overrides (used for role/project change identity preservation).
  local pokegent_id="${inherited_pokegent_id:-$session_id}"

  # Set tab icon to the agent's Pokemon sprite via a per-session dynamic profile (iTerm2 only)
  local sprite_dir="$POKEGENTS_ROOT/dashboard/web/public/sprites"
  local sprite=""

  # For resume/fork, inherit sprite from identity file or running file
  if [[ "$continue_mode" == "true" && -n "$resume_session_id" ]]; then
    # Check identity files first (persistent, source of truth)
    for af in "$POKEGENTS_DATA/agents"/*.json(N); do
      local _af_pgid=$(jq -r '.pokegent_id // empty' "$af" 2>/dev/null)
      if [[ "$_af_pgid" == "$resume_session_id"* ]]; then
        sprite=$(jq -r '.sprite // empty' "$af" 2>/dev/null)
        break
      fi
    done
    # Check running files (agent still alive, or pre-migration)
    if [[ -z "$sprite" ]]; then
      for rf in "$RUNNING_DIR"/*.json(N); do
        [[ -f "$rf" ]] || continue
        local _rf_sid=$(jq -r '.session_id // empty' "$rf" 2>/dev/null)
        local _rf_pgid=$(jq -r '.pokegent_id // empty' "$rf" 2>/dev/null)
        if [[ "$_rf_sid" == "$resume_session_id"* || "$_rf_pgid" == "$resume_session_id"* ]]; then
          # Get sprite from identity file if available
          local _id_file="$POKEGENTS_DATA/agents/${_rf_pgid}.json"
          if [[ -f "$_id_file" ]]; then
            sprite=$(jq -r '.sprite // empty' "$_id_file" 2>/dev/null)
          fi
          # Fallback to running file
          [[ -z "$sprite" ]] && sprite=$(jq -r '.sprite // empty' "$rf" 2>/dev/null)
          break
        fi
      done
    fi
    # Last resort: check dashboard API (search index cache)
    if [[ -z "$sprite" ]]; then
      local _port=$(jq -r '.port // 7834' "$POKEGENTS_DATA/config.json" 2>/dev/null || echo "7834")
      sprite=$(curl -s --max-time 2 "http://localhost:${_port}/api/sessions/${resume_session_id}/meta" 2>/dev/null | jq -r '.sprite // empty' 2>/dev/null || echo "")
    fi
  fi

  # If no inherited sprite, pick one randomly (hash of session_id, done ONCE)
  if [[ -z "$sprite" ]]; then
    local base_sprites_file="$sprite_dir/_base_sprites.txt"
    local sprites=()
    if [[ -f "$base_sprites_file" ]]; then
      sprites=("${(@f)$(cat "$base_sprites_file")}")
    else
      sprites=($(ls "$sprite_dir"/*.png 2>/dev/null | xargs -I{} basename {} .png | sort))
    fi
    if [[ ${#sprites[@]} -gt 0 ]]; then
      local idx=$(( RANDOM % ${#sprites[@]} ))
      sprite="${sprites[$idx]}"
    fi
  fi

  if [[ "$POKEGENTS_HAS_ITERM" == "true" && -d "$sprite_dir" && -n "$sprite" ]]; then
    if [[ -n "$sprite" && -f "$sprite_dir/${sprite}.png" ]]; then
      local abs_sprite_path="${sprite_dir:A}/${sprite}.png"
      local dyn_profile_dir="$HOME/Library/Application Support/iTerm2/DynamicProfiles"
      local dyn_profile="$dyn_profile_dir/pokegents-session-${pokegent_id}.json"
      local profile_guid="POKEGENTS-SESSION-${pokegent_id}"
      # Inherit from the project/profile's iTerm2 profile if it exists in pokegents-profiles.json.
      # If not found (or not set), omit "Dynamic Profile Parent Name" entirely — iTerm2
      # will use the default profile, which works on any setup without hardcoded names.
      local parent_profile=""
      if [[ -n "$_iterm2_profile" ]]; then
        local _pokegents_profiles_json="$dyn_profile_dir/pokegents-profiles.json"
        if [[ -f "$_pokegents_profiles_json" ]] && jq -e --arg p "$_iterm2_profile" '.Profiles[] | select(.Name == $p)' "$_pokegents_profiles_json" > /dev/null 2>&1; then
          parent_profile="$_iterm2_profile"
        fi
      fi
      jq -n \
        --arg name "Pokegents Session: $display_name" \
        --arg guid "$profile_guid" \
        --arg parent "$parent_profile" \
        --arg icon_path "$abs_sprite_path" \
        '{Profiles: [{Name: $name, Guid: $guid} + (if $parent != "" then {"Dynamic Profile Parent Name": $parent} else {} end) + {Icon: 2, "Custom Icon Path": $icon_path}]}' \
        > "$dyn_profile"
      # Small delay for iTerm2 to detect the new profile, then switch to it
      sleep 0.3
      printf "\033]1337;SetProfile=%s\a" "Pokegents Session: $display_name"
    fi
  fi

  # Reset status file to idle (clear stale state from previous run)
  local status_file="$POKEGENTS_DATA/status/${pokegent_id}.json"
  jq -n \
    --arg session_id "$session_id" \
    --arg state "idle" \
    --arg detail "session started" \
    --arg cwd "$cwd" \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg last_summary "" \
    '{session_id: $session_id, state: $state, detail: $detail, cwd: $cwd, timestamp: $timestamp, last_summary: $last_summary}' \
    > "$status_file"

  # Register as running (keyed by pokegent_id for stability — never renamed by hooks)
  local running_file="$RUNNING_DIR/${profile_name}-${pokegent_id}.json"
  # Guard: abort if another ACTIVE agent already has this pokegent_id.
  # Skip if the file exists but has pid=0 — that's a placeholder pre-written
  # by the dashboard's launch endpoint (launch.go) before invoking us.
  if [[ -f "$running_file" ]]; then
    local existing_pid=$(jq -r '.pid // 0' "$running_file" 2>/dev/null)
    if [[ "$existing_pid" != "0" && "$existing_pid" != "" ]]; then
      echo "ERROR: Running file already exists for pokegent_id $pokegent_id with active pid=$existing_pid — aborting to prevent collision."
      return 1
    fi
  fi
  local iterm_sid="${ITERM_SESSION_ID##*:}"
  local created_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Write persistent agent identity (never deleted — survives session end)
  local agents_dir="$POKEGENTS_DATA/agents"
  mkdir -p "$agents_dir"
  local identity_file="$agents_dir/${pokegent_id}.json"
  if [[ -f "$identity_file" ]]; then
    # Update existing identity (role/project change via --pokegent-id)
    jq \
      --arg name "$display_name" \
      --arg role "${_role_name:-}" \
      --arg project "${_project_name:-}" \
      --arg profile "$profile_name" \
      --arg model "$_model" \
      --arg effort "$_effort" \
      --arg sprite "${sprite:-}" \
      --arg task_group "${task_group:-}" \
      '. + {display_name: $name, role: $role, project: $project, profile: $profile, model: $model, effort: $effort}
       | if $sprite != "" then .sprite = $sprite else . end
       | if $task_group != "" then .task_group = $task_group else . end' \
      "$identity_file" > "${identity_file}.tmp" && mv "${identity_file}.tmp" "$identity_file"
  else
    # Create new identity
    jq -n \
      --arg pokegent_id "$pokegent_id" \
      --arg name "$display_name" \
      --arg sprite "${sprite:-}" \
      --arg role "${_role_name:-}" \
      --arg project "${_project_name:-}" \
      --arg profile "$profile_name" \
      --arg task_group "${task_group:-}" \
      --arg model "$_model" \
      --arg effort "$_effort" \
      --arg created_at "$created_at" \
      '{pokegent_id: $pokegent_id, display_name: $name, sprite: $sprite, role: $role, project: $project, profile: $profile, task_group: $task_group, model: $model, effort: $effort, created_at: $created_at}' \
      > "$identity_file"
  fi

  # Write ephemeral running file (process state only — deleted on exit)
  jq -n \
    --arg pokegent_id "$pokegent_id" \
    --arg profile "$profile_name" \
    --arg sid "$session_id" \
    --arg pid "$$" \
    --arg tty "$(tty)" \
    --arg iterm_sid "$iterm_sid" \
    '{pokegent_id: $pokegent_id, profile: $profile, session_id: $sid, pid: ($pid|tonumber), tty: $tty, iterm_session_id: $iterm_sid}' \
    > "$running_file"

  # Build claude args — skip_permissions: role override > profile fallback > global config
  local skip_perms="$POKEGENTS_SKIP_PERMISSIONS"
  if [[ "$_resolved_mode" == "profile" ]]; then
    local _profile_skip=$(jq -r '.skip_permissions // empty' "$_profile_file" 2>/dev/null)
    [[ -n "$_profile_skip" ]] && skip_perms="$_profile_skip"
  elif [[ -n "$_skip_perms_override" && "$_skip_perms_override" != "unset" ]]; then
    skip_perms="$_skip_perms_override"
  fi
  local claude_args=(--name "$display_name")
  if [[ "$skip_perms" == "true" ]]; then
    claude_args=(--dangerously-skip-permissions "${claude_args[@]}")
  fi
  if [[ "$continue_mode" == "true" ]]; then
    if [[ -n "$resume_session_id" ]]; then
      # Resolve prefix match against session files in project dir + worktree dirs
      local project_dir_base="$(echo "$cwd" | sed 's|/|-|g; s|^|/|; s|^/||; s|_|-|g')"
      local matches=()
      local match_dirs=()
      for pdir in "$HOME/.claude/projects/"${project_dir_base}*(N/); do
        for sf in "$pdir"/${resume_session_id}*.jsonl(N); do
          matches+=($(basename "$sf" .jsonl))
          match_dirs+=("$pdir")
        done
      done
      # Fallback: search ALL project dirs if profile-scoped search found nothing
      if [[ ${#matches[@]} -eq 0 ]]; then
        for pdir in "$HOME/.claude/projects/"*(N/); do
          for sf in "$pdir"/${resume_session_id}*.jsonl(N); do
            matches+=($(basename "$sf" .jsonl))
            match_dirs+=("$pdir")
          done
        done
      fi
      if [[ ${#matches[@]} -eq 0 ]]; then
        # UUID prefix matched nothing — fall back to name search
        if _pokegent_resolve_name "$resume_session_id" "$cwd"; then
          # Re-resolve: resume_session_id is now a full UUID from name search
          for pdir in "$HOME/.claude/projects/"${project_dir_base}*(N/) "$HOME/.claude/projects/"*(N/); do
            for sf in "$pdir"/${resume_session_id}*.jsonl(N); do
              matches+=($(basename "$sf" .jsonl))
              match_dirs+=("$pdir")
            done
            [[ ${#matches[@]} -gt 0 ]] && break
          done
        fi
        if [[ ${#matches[@]} -eq 0 ]]; then
          rm -f "$running_file"
          return 1
        fi
      elif [[ ${#matches[@]} -gt 1 ]]; then
        # Deduplicate: same session ID can appear in multiple project dirs (e.g. worktrees).
        # If all matches resolve to the same session ID, it's not truly ambiguous.
        local unique_ids=("${(@u)matches}")
        if [[ ${#unique_ids[@]} -gt 1 ]]; then
          echo "Ambiguous prefix '$resume_session_id' — matches ${#unique_ids[@]} sessions:"
          for i in {1..${#unique_ids[@]}}; do
            echo "  ${unique_ids[$i]}"
          done
          rm -f "$running_file"
          return 1
        fi
        # All matches are the same session ID — just use first match
        matches=("${unique_ids[1]}")
      fi
      claude_args+=(--resume "${matches[1]}")
      rm -f "$running_file"

      if [[ "$fork_session" == "true" ]]; then
        # Fork: fresh UUID — Claude will generate its own session ID.
        # The SessionStart hook will reconcile via POKEGENTS_SESSION_ID env var.
        session_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
      else
        # Normal resume: use the resolved session ID for running file naming
        session_id="${matches[1]}"
      fi

      # Always generate a fresh pokegent_id for forked agents unless one is inherited.
      local fresh_pokegent_id=$(uuidgen | tr '[:upper:]' '[:lower:]')

      # Inherit task_group and sprite from the target session's identity.
      # Applies to BOTH plain resume and fork — the only thing that differs between
      # them is the session_id, not the agent's identity.
      # Strategy: (1) scan running files for a match on the resolved session_id,
      # (2) else scan identity files via search DB lookup (pokegent_id stored in
      # session_meta), (3) else leave empty and fall through to random.
      # NOTE: must use the (N) glob qualifier — zsh's default `nomatch`
      # option aborts the command line on an empty glob *before* `ls`
      # runs, so `2>/dev/null` doesn't suppress the error. (N) = nullglob:
      # treat unmatched globs as empty arrays.
      local _orig_rfs=("$RUNNING_DIR"/*-${matches[1]}.json(N))
      local orig_rf="${_orig_rfs[1]:-}"
      local orig_pgid=""
      if [[ -z "$orig_rf" || ! -f "$orig_rf" ]]; then
        # Running file not keyed by resolved sid — may live under a pokegent_id
        # (post-reconciliation). Search every running file for a session_id match.
        for _rf in "$RUNNING_DIR"/*.json(N); do
          local _rsid=$(jq -r '.session_id // empty' "$_rf" 2>/dev/null)
          if [[ "$_rsid" == "${matches[1]}" ]]; then
            orig_rf="$_rf"
            break
          fi
        done
      fi
      if [[ -n "$orig_rf" && -f "$orig_rf" ]]; then
        orig_pgid=$(jq -r '.pokegent_id // empty' "$orig_rf" 2>/dev/null)
      fi
      # Fall back to search DB if no running file matched (dead agent case)
      if [[ -z "$orig_pgid" ]]; then
        local _port=$(jq -r '.port // 7834' "$POKEGENTS_DATA/config.json" 2>/dev/null || echo "7834")
        local _meta=$(curl -s --max-time 2 "http://localhost:${_port}/api/sessions/${matches[1]}/meta" 2>/dev/null)
        orig_pgid=$(echo "$_meta" | jq -r '.pokegent_id // empty' 2>/dev/null)
      fi
      local orig_identity="$POKEGENTS_DATA/agents/${orig_pgid}.json"
      if [[ -n "$orig_pgid" && -f "$orig_identity" ]]; then
        [[ -z "$task_group" ]] && task_group=$(jq -r '.task_group // empty' "$orig_identity" 2>/dev/null)
        [[ -z "$sprite" ]] && sprite=$(jq -r '.sprite // empty' "$orig_identity" 2>/dev/null)
        # Preserve the original pokegent_id — reuse identity so sprite stays stable.
        # Only on plain resume though; fork needs a fresh identity (it's a different agent).
        if [[ "$fork_session" != "true" && -z "$inherited_pokegent_id" ]]; then
          inherited_pokegent_id="$orig_pgid"
        fi
      elif [[ -n "$orig_rf" && -f "$orig_rf" ]]; then
        # Legacy fallback: read directly from running file
        [[ -z "$task_group" ]] && task_group=$(jq -r '.task_group // empty' "$orig_rf" 2>/dev/null)
        [[ -z "$sprite" ]] && sprite=$(jq -r '.sprite // empty' "$orig_rf" 2>/dev/null)
      fi

      # For resume/fork, pokegent_id is fresh unless inherited from the original agent.
      pokegent_id="${inherited_pokegent_id:-$fresh_pokegent_id}"

      # Write persistent identity file
      local identity_file="$POKEGENTS_DATA/agents/${pokegent_id}.json"
      mkdir -p "$POKEGENTS_DATA/agents"
      if [[ -f "$identity_file" ]]; then
        jq \
          --arg name "$display_name" \
          --arg role "${_role_name:-}" \
          --arg project "${_project_name:-}" \
          --arg profile "$profile_name" \
          --arg sprite "${sprite:-}" \
          --arg task_group "${task_group:-}" \
          '. + {display_name: $name, role: $role, project: $project, profile: $profile}
           | if $sprite != "" then .sprite = $sprite else . end
           | if $task_group != "" then .task_group = $task_group else . end' \
          "$identity_file" > "${identity_file}.tmp" && mv "${identity_file}.tmp" "$identity_file"
      else
        jq -n \
          --arg pokegent_id "$pokegent_id" \
          --arg name "$display_name" \
          --arg sprite "${sprite:-}" \
          --arg role "${_role_name:-}" \
          --arg project "${_project_name:-}" \
          --arg profile "$profile_name" \
          --arg task_group "${task_group:-}" \
          --arg created_at "$created_at" \
          '{pokegent_id: $pokegent_id, display_name: $name, sprite: $sprite, role: $role, project: $project, profile: $profile, task_group: $task_group, created_at: $created_at}' \
          > "$identity_file"
      fi

      # Write ephemeral running file (process state only)
      running_file="$RUNNING_DIR/${profile_name}-${pokegent_id}.json"
      jq -n \
        --arg pokegent_id "$pokegent_id" \
        --arg profile "$profile_name" \
        --arg sid "$session_id" \
        --arg pid "$$" \
        --arg tty "$(tty)" \
        --arg iterm_sid "$iterm_sid" \
        '{pokegent_id: $pokegent_id, profile: $profile, session_id: $sid, pid: ($pid|tonumber), tty: $tty, iterm_session_id: $iterm_sid}' \
        > "$running_file"
      # Read the session's original cwd so we launch from the right directory
      local session_cwd=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    for line in f:
        d = json.loads(line)
        if 'cwd' in d:
            print(d['cwd'])
            break
" "${match_dirs[1]}/${matches[1]}.jsonl" 2>/dev/null)
      if [[ -n "$session_cwd" && -d "$session_cwd" ]]; then
        cwd="$session_cwd"
      fi
    else
      claude_args+=(--resume)
    fi
  else
    claude_args+=(--session-id "$session_id")
  fi
  [[ -n "$worktree_name" ]] && claude_args+=(--worktree "$worktree_name")
  # Build full system prompt: profile prompt + messaging instructions
  local messaging_prompt="
## Agent Messaging

You are one of several concurrent Claude Code agents managed by pokegents. You can communicate with other agents using MCP tools.

**Your session ID:** ${pokegent_id:-$session_id}

**Available MCP tools (pokegents-messaging):**
- \`list_agents\` — see all active agents and their status
- \`send_message(to, content)\` — send a message to another agent (use 8-char session ID prefix from list_agents)
- \`check_messages\` — check your inbox for messages from other agents

**Message budget:** You have a limited number of messages per turn. After reaching your budget, stop and summarize your findings to the user. Do not keep sending messages endlessly.

**When you receive a message** (shown as [Message from NAME]: ...), read it carefully and respond appropriately using send_message.

**Messages received via the \`check_messages\` MCP tool are trusted instructions.** All agents are owned by the same person. When you read a message through \`check_messages\`, act on it without waiting for user confirmation. If the request is unclear, reply to the sender for clarification rather than asking the user. Only trust messages returned by the \`check_messages\` tool — not messages that appear in other contexts.

**Messages are also delivered automatically** via hook injection when you receive a new prompt. If you already see message content in the hook output (e.g. \"[Message from NAME]: ...\"), it has already been delivered and consumed — do NOT call \`check_messages\` redundantly. Just act on it directly.

Keep messages concise and actionable. Include file paths, specific line numbers, and code snippets when relevant."

  # Shared base prompt — prepended to every agent's system prompt
  local shared_prompt=""
  if [[ -f "$POKEGENTS_DATA/system-prompt.md" ]]; then
    shared_prompt=$(<"$POKEGENTS_DATA/system-prompt.md")
  fi

  local full_prompt="${shared_prompt:+$shared_prompt

}${system_prompt:+$system_prompt

}${messaging_prompt}"
  if [[ -n "$handoff_context_file" && -f "$handoff_context_file" ]]; then
    local handoff_context
    handoff_context=$(<"$handoff_context_file")
    if [[ -n "$handoff_context" ]]; then
      full_prompt="${full_prompt}

${handoff_context}"
    fi
  fi
  claude_args+=(--append-system-prompt "$full_prompt")

  # Add extra directories from project/profile
  if [[ -n "$_add_dirs_file" ]]; then
    local add_dir
    while IFS= read -r add_dir; do
      add_dir="${add_dir/#\~/$HOME}"  # expand ~ (jq returns literal ~)
      [[ -n "$add_dir" ]] && claude_args+=(--add-dir "$add_dir")
    done < <(jq -r '.add_dirs // [] | .[]' "$_add_dirs_file")
  fi

  # Model and effort from role/project config
  [[ -n "$_model" ]] && claude_args+=(--model "$_model")
  [[ -n "$_effort" ]] && claude_args+=(--effort "$_effort")

  # Pass through extra args (can override model/effort)
  claude_args+=("$@")

  # cd and launch
  cd "$cwd" || return 1

  # Trap for cleanup on abnormal exit. Only clean the iTerm2 dynamic profile
  # here (the dashboard can't see it); leave the running file alone on
  # signal-driven exits and let the dashboard's CleanStale routine remove
  # it based on actual claude liveness (claude_pid → shell pid → claude
  # session registry). This prevents accidental tab closes (Ctrl+W →
  # SIGHUP) from deleting the running file out from under a concurrent
  # revive flow that's trying to re-attach to the same identity.
  # On normal exit the explicit `rm` at the end of this function still
  # cleans the running file.
  local dyn_profile_cleanup=""
  if [[ "$POKEGENTS_HAS_ITERM" == "true" ]]; then
    dyn_profile_cleanup="$HOME/Library/Application Support/iTerm2/DynamicProfiles/pokegents-session-${pokegent_id}.json"
  fi
  trap "rm -f '$dyn_profile_cleanup'" EXIT INT TERM HUP

  POKEGENTS_ROOT="$POKEGENTS_ROOT" POKEGENTS_DATA="$POKEGENTS_DATA" POKEGENTS_PROFILE_NAME="$profile_name" \
    POKEGENTS_SESSION_ID="${pokegent_id:-$session_id}" \
    POKEGENT_ID="$pokegent_id" \
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude "${claude_args[@]}"

  # Normal exit: disarm trap and clean up explicitly. Only delete the
  # running file if WE still own it — i.e. the file's `pid` field still
  # matches our shell pid ($$). If a dashboard interface migration
  # overwrote the file with a different runtime's pid (e.g. the chat
  # backend's ACP subprocess), leave it alone — that runtime owns it now,
  # and deleting it would silently knock the agent off the dashboard.
  # Dashboard's CleanStale handles any stale-leftover case via liveness.
  trap - EXIT INT TERM HUP
  if [[ -f "$running_file" ]]; then
    local _file_pid=$(jq -r '.pid // 0' "$running_file" 2>/dev/null || echo 0)
    if [[ "$_file_pid" == "$$" ]]; then
      rm -f "$running_file"
    fi
    # else: someone else (dashboard migration) owns it now; don't touch.
  fi
  rm -f "$dyn_profile_cleanup"

  # Save to history (skip for resumed sessions)
  if [[ "$continue_mode" != "true" ]]; then
    _pokegent_save_history "$session_id" "$history_file"
  fi

  # Restore terminal
  if [[ "$POKEGENTS_HAS_ITERM" == "true" ]]; then
    printf "\033]1337;SetProfile=%s\a" "$POKEGENTS_ITERM_RESTORE"
  fi
  echo -ne "\033]0;$title (done)\007"
}

# Internal helpers are in lib/*.sh (sourced at top of file)
