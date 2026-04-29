package server

// Phase 4 — Interface migration.
//
// `POST /api/sessions/{id}/migrate {to: "iterm2" | "chat"}` swaps the runtime
// behind a pokegent without changing its identity. Same pokegent_id, same
// sprite, same role/project, same Claude session_id (so the JSONL transcript
// continues), same mailbox (already keyed by pokegent_id from Phase 1).
//
// What gets reset is process-scoped state: status file's last_summary,
// recent_actions, context_tokens. Those naturally repopulate on the new
// process's first turn.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"pokegents/dashboard/server/store"
)

// findJSONLForSession returns the path of a JSONL transcript matching
// session_id under any project dir. Used by migration to verify the resume
// target actually exists on disk before tearing down the running runtime.
func findJSONLForSession(sessionID string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	pattern := filepath.Join(home, ".claude", "projects", "*", sessionID+".jsonl")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("no jsonl found for session %s", sessionID)
	}
	return matches[0], nil
}

// extractCwdFromJSONL reads the JSONL line by line and returns the first
// non-null cwd field. Claude Code stores its JSONL under
// ~/.claude/projects/{cwd-hash}/{session_id}.jsonl, where cwd-hash is the
// session-creation cwd with `/` → `-` (irreversibly — paths with literal
// dashes can't be decoded). The JSONL itself records the actual cwd in each
// user/system entry, so reading it back is the only reliable way to recover
// the cwd that `session/load` will look for the JSONL relative to.
func extractCwdFromJSONL(jsonlPath string) (string, error) {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var entry struct {
			Cwd *string `json:"cwd"`
		}
		if err := json.Unmarshal(sc.Bytes(), &entry); err != nil {
			continue
		}
		if entry.Cwd != nil && *entry.Cwd != "" {
			return *entry.Cwd, nil
		}
	}
	return "", fmt.Errorf("no cwd found in jsonl %s", jsonlPath)
}

func (s *Server) handleMigrateInterface(w http.ResponseWriter, r *http.Request) {
	idHint := r.PathValue("id")
	var body struct {
		To string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.To != "iterm2" && body.To != "chat" {
		http.Error(w, "to must be 'iterm2' or 'chat'", http.StatusBadRequest)
		return
	}

	pgid := s.resolveToPokegentID(idHint)
	agent := s.state.GetAgent(pgid)
	if agent == nil {
		http.Error(w, "agent not found: "+idHint, http.StatusNotFound)
		return
	}
	if agent.SessionID == "" {
		http.Error(w, "agent has no Claude session_id yet — try again in a moment", http.StatusConflict)
		return
	}
	// Migration's only hard requirement is that the JSONL transcript exists
	// on disk for the resume target. Both backends ultimately call
	// `claude --resume <session_id>` (or ACP `session/load`) which read
	// `~/.claude/projects/{cwd-hash}/{session_id}.jsonl`. If the JSONL is
	// missing, the SDK aborts silently and we lose the agent. Check up-front
	// so we can refuse cleanly.
	jsonlPath, err := findJSONLForSession(agent.SessionID)
	if err != nil {
		http.Error(w, "no transcript on disk for session_id "+agent.SessionID[:min(8, len(agent.SessionID))]+"… — agent's session is corrupted; try Revive from PC box and check ~/.claude/projects/", http.StatusConflict)
		return
	}
	current := agent.Interface
	if current == "" {
		current = "iterm2"
	}
	if current == body.To {
		http.Error(w, fmt.Sprintf("agent is already on interface %q", body.To), http.StatusBadRequest)
		return
	}

	switch body.To {
	case "chat":
		if err := s.migrateToChat(r.Context(), agent, jsonlPath); err != nil {
			http.Error(w, "migrate to chat failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
	case "iterm2":
		if err := s.migrateToITerm2(agent); err != nil {
			http.Error(w, "migrate to iterm2 failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}

	s.eventBus.Publish("state_update", s.state.GetAgents())
	writeJSON(w, map[string]any{
		"pokegent_id": pgid,
		"interface":   body.To,
		"session_id":  agent.SessionID,
	})
}

func (s *Server) migrateToChat(ctx context.Context, agent *AgentState, jsonlPath string) error {
	pgid := agent.PokegentID
	if pgid == "" {
		pgid = agent.SessionID
	}

	// Resolve role/project from identity for system prompt only. Cwd is read
	// from the JSONL (not recomputed from profile/project) — `session/load`
	// looks up the JSONL relative to its launch cwd, so we MUST launch the
	// chat backend with the same cwd the session was created in. Worktrees,
	// sub-projects, and any agent that wasn't launched from the project
	// default would otherwise hit `Resource not found` on session/load.
	ident, _ := s.fileStore.Agents.Get(pgid)
	role, project := "", ""
	if ident != nil {
		role = ident.Role
		project = ident.Project
	}
	cwd, err := extractCwdFromJSONL(jsonlPath)
	if err != nil {
		return fmt.Errorf("read cwd from transcript: %w", err)
	}
	systemPrompt := s.composeSystemPrompt(LaunchRequest{Role: role, Project: project})

	// Snapshot the current running file so we can roll back on failure.
	runningGlob := filepath.Join(s.dataDir, "running", "*-"+pgid+".json")
	matches, _ := filepath.Glob(runningGlob)
	var oldPath string
	var oldData []byte
	if len(matches) > 0 {
		oldPath = matches[0]
		oldData, _ = os.ReadFile(oldPath)
	}

	// Pre-write running file with interface=chat (placeholder pid=0; the
	// chat supervisor patches in subprocess pid via patchRunningFileChat).
	rs := store.RunningSession{
		Profile:     agent.ProfileName,
		PokegentID:  pgid,
		SessionID:   agent.SessionID, // preserve so the JSONL keeps matching
		DisplayName: agent.DisplayName,
		Sprite:      agent.Sprite,
		TaskGroup:   agent.TaskGroup,
		Model:       agent.Model,
		Effort:      agent.Effort,
		Interface:   "chat",
	}
	newPath, err := writePlaceholderRunningFile(filepath.Join(s.dataDir, "running"), rs)
	if err != nil {
		return fmt.Errorf("rewrite running file: %w", err)
	}

	// Spawn chat backend FIRST. If it fails to start, the iTerm tab is
	// untouched and we can roll back the running file cleanly. Only after
	// the backend is alive do we tear down the iTerm tab — that way the
	// user is never stranded with neither runtime alive.
	launchCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if _, err := s.chatMgr.Launch(launchCtx, ChatLaunchOptions{
		PokegentID:         pgid,
		Profile:            agent.ProfileName,
		Cwd:                cwd,
		SystemPromptAppend: systemPrompt,
		// agent.Model/Effort are the resolved values from state.go's
		// rebuildAgents enrichment (running-file → role config → project
		// config). Passing them here keeps the chat backend in sync with
		// what AgentState advertises so the StatusBar isn't lying.
		Model:           agent.Model,
		Effort:          agent.Effort,
		ResumeSessionID: agent.SessionID,
	}); err != nil {
		// Roll back: restore previous running file (if any), leave iTerm alive.
		// `newPath` and `oldPath` may differ (e.g. profile-rename between
		// reads), so when we restore oldPath we still need to clear newPath
		// or both files will exist and the dashboard will see two running
		// entries for the same pgid.
		if oldData != nil && oldPath != "" {
			_ = os.WriteFile(oldPath, oldData, 0o644)
			if newPath != oldPath {
				_ = os.Remove(newPath)
			}
		} else {
			_ = os.Remove(newPath)
		}
		return fmt.Errorf("start chat backend: %w", err)
	}

	// Chat backend confirmed alive. Now safe to tear down the iTerm tab and
	// flip identity over to chat. pokegent.sh's exit cleanup checks the
	// running file's `pid` field against its own $$ before deleting, so it
	// won't wipe the chat backend's freshly-written file (chat's pid is the
	// ACP subprocess, not the shell). See pokegent.sh:1109-1124.
	if agent.ITermSessionID != "" || agent.TTY != "" {
		_ = s.terminal.CloseSession(agent.ITermSessionID, agent.TTY)
	}
	_ = s.fileStore.Agents.Update(pgid, func(id *store.AgentIdentity) {
		id.Interface = "chat"
	})

	// Belt-and-suspenders for pre-fix pokegent.sh agents (launched before
	// the ownership check at pokegent.sh:1109-1124 was added). Those old
	// shells unconditionally `rm -f $running_file` on exit, which races
	// against the chat backend's freshly-written file. We rewrite at
	// T+1.5s to restore it. For agents on the new pokegent.sh, the
	// ownership check protects the file and this rewrite is a no-op.
	// Safe to remove once all in-flight agents have cycled to the new
	// pokegent.sh.
	go func() {
		time.Sleep(1500 * time.Millisecond)
		s.chatMgr.repatchRunningFile(pgid)
		s.eventBus.Publish("state_update", s.state.GetAgents())
	}()
	return nil
}

func (s *Server) migrateToITerm2(agent *AgentState) error {
	pgid := agent.PokegentID
	if pgid == "" {
		pgid = agent.SessionID
	}

	// Tear down ACP subprocess. Its exit handler removes running + status
	// files asynchronously — we wait briefly to avoid racing the new launch
	// against the cleanup.
	s.chatMgr.Close(pgid)
	time.Sleep(500 * time.Millisecond)

	// Update identity file's interface field.
	_ = s.fileStore.Agents.Update(pgid, func(id *store.AgentIdentity) {
		id.Interface = "iterm2"
	})

	// Pre-write running file (placeholder pid=0) with interface=iterm2 so
	// the dashboard sees the agent immediately on the new backend; pokegent.sh
	// will atomically overwrite with real values once it starts.
	rs := store.RunningSession{
		Profile:     agent.ProfileName,
		PokegentID:  pgid,
		SessionID:   agent.SessionID,
		DisplayName: agent.DisplayName,
		Sprite:      agent.Sprite,
		TaskGroup:   agent.TaskGroup,
		Model:       agent.Model,
		Effort:      agent.Effort,
		Interface:   "iterm2",
	}
	if _, err := writePlaceholderRunningFile(filepath.Join(s.dataDir, "running"), rs); err != nil {
		return fmt.Errorf("rewrite running file: %w", err)
	}

	// Resume in iTerm2 with the same Claude session_id and pokegent_id.
	// pokegent.sh handles --resume + --pokegent-id correctly (both flags
	// already exist, see pokegent.sh:568-575 and resume flow).
	if err := s.terminal.ResumePokegent(agent.ProfileName, agent.SessionID, pgid, ""); err != nil {
		return fmt.Errorf("resume in iterm2: %w", err)
	}
	return nil
}
