package server

// Unified launch endpoint per `pokegents-unified-launch.md`.
// One entry point for all pokegent launches regardless of interface.
// Server-side guarantees per Principle 6:
// - Mints `pokegent_id` before any subprocess runs.
// - Pre-writes the running file *before* invoking the adapter, so the dashboard
//   has a consistent record even if the spawned launcher fails.
// - Cleans the placeholder up on dispatch error.

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pokegents/dashboard/server/store"
)

// LaunchRequest is the body of POST /api/pokegents/launch.
type LaunchRequest struct {
	// Either Profile (legacy "role@project" string) or Role/Project must be set.
	Profile          string `json:"profile,omitempty"`
	Role             string `json:"role,omitempty"`
	Project          string `json:"project,omitempty"`
	Name             string `json:"name,omitempty"`
	Sprite           string `json:"sprite,omitempty"`
	Model            string `json:"model,omitempty"`
	Effort           string `json:"effort,omitempty"`
	TaskGroup        string `json:"task_group,omitempty"`
	ParentPokegentID string `json:"parent_pokegent_id,omitempty"`
	// Interface picks the runtime backend. "iterm2" (default) or "chat".
	Interface string `json:"interface,omitempty"`
}

// LaunchResponse is what the dashboard returns to the frontend.
type LaunchResponse struct {
	PokegentID string `json:"pokegent_id"`
	Profile    string `json:"profile"`
	Interface  string `json:"interface"`
}

func (s *Server) handleUnifiedLaunch(w http.ResponseWriter, r *http.Request) {
	var body LaunchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	iface := body.Interface
	if iface == "" {
		iface = "iterm2"
	}
	if iface != "iterm2" && iface != "chat" {
		http.Error(w, fmt.Sprintf("unknown interface %q (must be 'iterm2' or 'chat')", iface), http.StatusBadRequest)
		return
	}

	profile, err := composeProfile(body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	pgid, err := newPokegentID()
	if err != nil {
		http.Error(w, "failed to mint pokegent_id: "+err.Error(), http.StatusInternalServerError)
		return
	}

	displayName := body.Name
	if displayName == "" {
		displayName = "starting…"
	}

	// Principle 6: pre-write the running file before any subprocess runs.
	// Real `pid`/`tty`/`iterm_session_id` get patched in by `pokegent.sh` and
	// then the SessionStart hook (iterm2), or by the ChatManager directly (chat).
	rs := store.RunningSession{
		Profile:     profile,
		PokegentID:  pgid,
		DisplayName: displayName,
		TaskGroup:   body.TaskGroup,
		Sprite:      body.Sprite,
		Model:       body.Model,
		Effort:      body.Effort,
		Interface:   iface,
	}
	runningPath, err := writePlaceholderRunningFile(filepath.Join(s.dataDir, "running"), rs)
	if err != nil {
		http.Error(w, "failed to pre-write running file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	if iface == "chat" {
		cwd := s.resolveCwd(body, profile)
		systemPrompt := s.composeSystemPrompt(body)
		// Resolve model/effort from request → role config → project config
		// (same precedence pokegent.sh uses for iterm2 launches). Without
		// this the chat backend would always run on SDK defaults even when
		// role/project configs declare a model.
		model, effort := s.resolveModelEffort(body.Model, body.Effort, body.Role, body.Project)
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		if _, err := s.chatMgr.Launch(ctx, ChatLaunchOptions{
			PokegentID:         pgid,
			Profile:            profile,
			Cwd:                cwd,
			SystemPromptAppend: systemPrompt,
			Model:              model,
			Effort:             effort,
		}); err != nil {
			_ = os.Remove(runningPath)
			http.Error(w, "chat launch failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		// Persist identity now that the supervisor confirmed the agent is alive.
		s.persistChatIdentity(pgid, profile, body, displayName)
		s.eventBus.Publish("state_update", s.state.GetAgents())
		writeJSON(w, LaunchResponse{PokegentID: pgid, Profile: profile, Interface: iface})
		return
	}

	// iterm2 dispatch
	itermProfile := ""
	if p := s.state.GetProfile(profile); p != nil {
		itermProfile = p.ITermProfile
	}

	if err := s.terminal.LaunchProfile(LaunchOptions{
		Profile:      profile,
		ITermProfile: itermProfile,
		TaskGroup:    body.TaskGroup,
		PokegentID:   pgid,
	}); err != nil {
		_ = os.Remove(runningPath)
		http.Error(w, "launch failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	s.eventBus.Publish("state_update", s.state.GetAgents())
	writeJSON(w, LaunchResponse{PokegentID: pgid, Profile: profile, Interface: iface})
}

// resolveCwd derives the working directory for a chat launch from project
// config (with fallback to home). For iterm2 launches pokegent.sh handles
// this internally; chat launches need the cwd up-front for the subprocess.
// Expands a leading `~` since project configs store the user-friendly form.
func (s *Server) resolveCwd(body LaunchRequest, profile string) string {
	// Try project name from request first, then parse from profile string.
	projectName := body.Project
	if projectName == "" {
		// profile is "role@project" — extract the project half.
		if at := strings.IndexByte(profile, '@'); at >= 0 && at+1 < len(profile) {
			projectName = profile[at+1:]
		}
	}
	if projectName != "" {
		if p, err := s.fileStore.Projects.Get(projectName); err == nil && p != nil && p.CWD != "" {
			return expandTilde(p.CWD)
		}
	}
	// Profile-as-legacy-bare lookup.
	if p := s.state.GetProfile(profile); p != nil && p.CWD != "" {
		return expandTilde(p.CWD)
	}
	home, _ := os.UserHomeDir()
	return home
}

func expandTilde(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			if p == "~" {
				return home
			}
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

// composeSystemPrompt builds the role+project system prompt to append to the
// Claude Code preset. Mirrors what pokegent.sh assembles for iterm2 launches.
// Empty string → use SDK default (Claude Code preset alone).
func (s *Server) composeSystemPrompt(body LaunchRequest) string {
	var parts []string
	if body.Role != "" {
		if r, err := s.fileStore.Roles.Get(body.Role); err == nil && r != nil && r.SystemPrompt != "" {
			parts = append(parts, r.SystemPrompt)
		}
	}
	if body.Project != "" {
		if p, err := s.fileStore.Projects.Get(body.Project); err == nil && p != nil && p.ContextPrompt != "" {
			parts = append(parts, p.ContextPrompt)
		}
	}
	return strings.Join(parts, "\n\n")
}

// persistChatIdentity writes a permanent identity file for a chat-backed
// pokegent so it shows up in PC box, search, and survives restart. iterm2
// launches do this from inside pokegent.sh; chat does it server-side.
func (s *Server) persistChatIdentity(pgid, profile string, body LaunchRequest, displayName string) {
	sprite := body.Sprite
	if sprite == "" {
		sprite = pickDefaultSprite(pgid)
	}
	id := store.AgentIdentity{
		PokegentID:  pgid,
		DisplayName: displayName,
		Sprite:      sprite,
		Role:        body.Role,
		Project:     body.Project,
		Profile:     profile,
		TaskGroup:   body.TaskGroup,
		Model:       body.Model,
		Effort:      body.Effort,
		Interface:   "chat",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := s.fileStore.Agents.Save(id); err != nil {
		log.Printf("chat: persist identity %s failed: %v", pgid[:8], err)
	}
}

// composeProfile picks the correct profile string for pokegent.sh from a
// LaunchRequest. Direct `Profile` wins; otherwise `role@project` is assembled
// from the parts.
func composeProfile(body LaunchRequest) (string, error) {
	if body.Profile != "" {
		return body.Profile, nil
	}
	switch {
	case body.Role != "" && body.Project != "":
		return body.Role + "@" + body.Project, nil
	case body.Project != "":
		return "@" + body.Project, nil
	case body.Role != "":
		return body.Role + "@", nil
	}
	return "", fmt.Errorf("must specify profile, role, or project")
}

func writePlaceholderRunningFile(runningDir string, rs store.RunningSession) (string, error) {
	if err := os.MkdirAll(runningDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(runningDir, fmt.Sprintf("%s-%s.json", rs.Profile, rs.PokegentID))
	data, err := json.MarshalIndent(rs, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// newPokegentID returns a lowercase RFC 4122 v4 UUID.
func newPokegentID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// pickDefaultSprite picks a sprite using the same int32-overflow hash as
// pokegent.sh and the dashboard's notifier — keeps sprite assignment stable
// across processes and matches what iterm2 launches see.
func pickDefaultSprite(id string) string {
	sprites := defaultSpriteList()
	if len(sprites) == 0 {
		return "pokeball"
	}
	var h int32
	for _, c := range id {
		h = ((h << 5) - h) + int32(c)
	}
	if h < 0 {
		h = -h
	}
	return sprites[int(h)%len(sprites)]
}

// copyFile copies src to dst. Used by chat clone to fork a JSONL transcript.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

// defaultSpriteList is a small fallback. The full list lives in the sprite
// directory; for default-pick parity we use this stable subset.
func defaultSpriteList() []string {
	return []string{
		"pokeball", "pikachu", "charizard", "snorlax", "eevee", "lotad",
		"jirachi", "gloom", "glalie", "machop", "psyduck", "rhyhorn",
	}
}
