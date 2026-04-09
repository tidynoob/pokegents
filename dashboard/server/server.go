package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"pokegents/dashboard/server/services"
	"pokegents/dashboard/server/store"
)

// Server is the main dashboard HTTP server.
type Server struct {
	state     *StateManager
	eventBus  *EventBus
	notifier  *Notifier
	storeWatcher *store.StoreWatcher
	msgSvc    *services.MessagingService
	searchSvc *services.SearchService
	terminal  TerminalIntegration
	fileStore *store.Store
	mux       *http.ServeMux
	port      int
	webDir    string

	pendingResumeTaskGroups map[string]string // old session_id → task group
	pendingResumeSpriteMu   sync.Mutex       // guards pendingResumeTaskGroups
}

// Config holds server configuration.
type Config struct {
	Port             int
	DataDir          string
	ClaudeProjectDir string
	SearchDBPath     string
	WebDir           string
}

// DefaultConfig returns config with sensible defaults, reading port from ~/.ccsession/config.json.
func DefaultConfig() Config {
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".pokegents")

	// Read port from config file
	port := 7834
	if data, err := os.ReadFile(filepath.Join(dataDir, "config.json")); err == nil {
		var cfg struct {
			Port int `json:"port"`
		}
		if json.Unmarshal(data, &cfg) == nil && cfg.Port > 0 {
			port = cfg.Port
		}
	}

	return Config{
		Port:             port,
		DataDir:          dataDir,
		ClaudeProjectDir: filepath.Join(home, ".claude", "projects"),
		SearchDBPath:     filepath.Join(dataDir, "search.db"),
		WebDir:           "", // set at runtime
	}
}

func NewServer(cfg Config) (*Server, error) {
	fileStore := store.NewFileStore(cfg.DataDir)
	state := NewStateManagerWithStore(fileStore, cfg.DataDir, cfg.ClaudeProjectDir)
	eventBus := NewEventBus()
	notifier := NewNotifier(cfg.WebDir, cfg.DataDir)
	terminal := NewTerminal()

	// Services
	msgSvc := services.NewMessagingService(
		fileStore.Messages,
		terminal.WriteText,
		func(id string) *services.AgentInfo {
			a := state.GetAgent(id)
			if a == nil {
				return nil
			}
			return &services.AgentInfo{
				State: a.State, IsAlive: a.IsAlive,
				LastUpdated: a.LastUpdated, TTY: a.TTY,
				ITermSessionID: a.ITermSessionID,
			}
		},
		terminal.IsSessionFocused,
	)

	// Search service
	searchSvc, searchErr := services.NewSearchService(cfg.SearchDBPath, cfg.ClaudeProjectDir, fileStore.Profiles,
		services.ProfileMatcherFunc(func(cwd string) string {
			name, _, _ := state.MatchProfile(cwd)
			return name
		}),
	)
	if searchErr != nil {
		log.Printf("search service unavailable: %v", searchErr)
	}

	sw := store.NewStoreWatcher(cfg.DataDir)

	s := &Server{
		state:        state,
		eventBus:     eventBus,
		notifier:     notifier,
		storeWatcher: sw,
		msgSvc:       msgSvc,
		searchSvc:    searchSvc,
		terminal:     terminal,
		fileStore:    fileStore,
		mux:                  http.NewServeMux(),
		port:                 cfg.Port,
		webDir:               cfg.WebDir,
		pendingResumeTaskGroups: make(map[string]string),
	}

	s.routes()
	return s, nil
}

func (s *Server) routes() {
	// API routes
	s.mux.HandleFunc("GET /api/sessions", s.handleGetSessions)
	s.mux.HandleFunc("GET /api/sessions/{id}", s.handleGetSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/resume", s.handleResumeSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/focus", s.handleFocusSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/rename", s.handleRenameSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/sprite", s.handleSetSprite)
	s.mux.HandleFunc("POST /api/sessions/{id}/role", s.handleSetRole)
	s.mux.HandleFunc("POST /api/sessions/{id}/project", s.handleSetProject)
	s.mux.HandleFunc("POST /api/sessions/{id}/task-group", s.handleSetTaskGroup)
	s.mux.HandleFunc("POST /api/sessions/{id}/prompt", s.handleSendPrompt)
	s.mux.HandleFunc("POST /api/sessions/{id}/check-messages", s.handleCheckMessages)
	s.mux.HandleFunc("POST /api/sessions/{id}/clone", s.handleCloneSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/shutdown", s.handleShutdownSession)
	s.mux.HandleFunc("POST /api/task-groups/{name}/release", s.handleReleaseTaskGroup)
	s.mux.HandleFunc("GET /api/task-groups/{name}/sessions", s.handleGetTaskGroupSessions)
	s.mux.HandleFunc("GET /api/sessions/{id}/transcript", s.handleGetTranscript)
	s.mux.HandleFunc("GET /api/sessions/{id}/preview", s.handleSessionPreview)
	s.mux.HandleFunc("POST /api/sessions/{id}/image", s.handleUploadImage)
	s.mux.HandleFunc("GET /api/profiles", s.handleGetProfiles)
	s.mux.HandleFunc("GET /api/projects", s.handleGetProjects)
	s.mux.HandleFunc("GET /api/roles", s.handleGetRoles)
	s.mux.HandleFunc("POST /api/profiles/{name}/launch", s.handleLaunchProfile)
	s.mux.HandleFunc("POST /api/launch", s.handleLaunch)
	s.mux.HandleFunc("GET /api/agent-order", s.handleGetAgentOrder)
	s.mux.HandleFunc("PUT /api/agent-order", s.handleSetAgentOrder)
	s.mux.HandleFunc("GET /api/events", s.eventBus.ServeSSE)
	s.mux.HandleFunc("POST /api/events", s.handlePostEvent)
	s.mux.HandleFunc("GET /api/search", s.handleSearch)
	s.mux.HandleFunc("GET /api/search/recent", s.handleSearchRecent)
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("POST /api/messages", s.handleSendMessage)
	s.mux.HandleFunc("POST /api/messages/send", s.handleSendMessageResolved)
	s.mux.HandleFunc("GET /api/messages", s.handleGetMessages)
	s.mux.HandleFunc("GET /api/messages/connections", s.handleGetConnections)
	s.mux.HandleFunc("GET /api/messages/pending/{id}", s.handleGetPending)
	s.mux.HandleFunc("POST /api/messages/deliver/{id}", s.handleDeliverPending)
	s.mux.HandleFunc("POST /api/messages/consume/{id}", s.handleConsumePending)
	s.mux.HandleFunc("GET /api/activity", s.handleGetActivity)
	s.mux.HandleFunc("GET /api/grid-layout", s.handleGetGridLayout)
	s.mux.HandleFunc("PUT /api/grid-layout", s.handleSetGridLayout)
	s.mux.HandleFunc("GET /api/grid-profiles", s.handleListGridProfiles)
	s.mux.HandleFunc("GET /api/grid-profiles/{name}", s.handleGetGridProfile)
	s.mux.HandleFunc("PUT /api/grid-profiles/{name}", s.handleSetGridProfile)
	s.mux.HandleFunc("DELETE /api/grid-profiles/{name}", s.handleDeleteGridProfile)
	s.mux.HandleFunc("POST /api/ephemeral", s.handleCreateEphemeral)
	s.mux.HandleFunc("PUT /api/ephemeral/{id}/complete", s.handleCompleteEphemeral)
	s.mux.HandleFunc("DELETE /api/ephemeral/{id}", s.handleDeleteEphemeral)

	// Serve frontend static files
	if s.webDir != "" {
		fs := http.FileServer(http.Dir(s.webDir))
		s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			path := filepath.Join(s.webDir, r.URL.Path)
			isAsset := strings.HasPrefix(r.URL.Path, "/assets/")
			servingIndex := false

			// SPA fallback: serve index.html for unknown paths
			if _, err := os.Stat(path); os.IsNotExist(err) && r.URL.Path != "/" {
				servingIndex = true
			}
			if r.URL.Path == "/" || r.URL.Path == "/index.html" {
				servingIndex = true
			}

			if servingIndex {
				// Never cache index.html — ensures new JS/CSS hashes are picked up
				w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
				http.ServeFile(w, r, filepath.Join(s.webDir, "index.html"))
				return
			}
			if isAsset {
				// Short cache for dev — allows quick iteration without hard refresh
				w.Header().Set("Cache-Control", "public, max-age=10")
			}
			fs.ServeHTTP(w, r)
		})
	}
}

// Start initializes state, starts watcher and search, and listens on the port.
func (s *Server) Start() error {
	// Load initial state
	if err := s.state.LoadAll(); err != nil {
		return fmt.Errorf("failed to load state: %w", err)
	}
	log.Printf("loaded %d profiles, %d agents", len(s.state.GetProfiles()), len(s.state.GetAgents()))

	// Start file watcher — single broadcast point for all file changes
	if err := s.storeWatcher.Start(); err != nil {
		log.Printf("watcher failed to start: %v", err)
	}
	go s.watcherLoop()

	// Start search indexer — sync running session metadata after first index build
	if s.searchSvc != nil {
		s.searchSvc.StartBackgroundIndexer(5*time.Minute, s.syncSessionMetaToSearch)
	}

	// Start transcript poller for live trace updates
	s.startTracePoller()

	addr := fmt.Sprintf(":%d", s.port)
	log.Printf("dashboard server listening on http://localhost%s", addr)
	return http.ListenAndServe(addr, s.corsMiddleware(s.mux))
}

// startTracePoller polls transcript files every 2 seconds for busy agents
// to get live thinking/output traces (hooks only fire on tool events, not mid-generation).
func (s *Server) startTracePoller() {
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			// Clean up stale running files, reconcile mismatched session IDs,
			// and transition done→idle after 10 minutes
			if s.state.CleanStale() || s.state.ReconcileRunningFiles() || s.state.TransitionDoneToIdle() {
				s.eventBus.Publish("state_update", s.state.GetAgents())
			}

			agents := s.state.GetAgents()
			changed := false
			for _, a := range agents {
				transcriptPath := s.state.FindTranscriptPath(a.SessionID)
				if transcriptPath == "" {
					continue
				}
				// Backfill missing user prompt
				if a.UserPrompt == "" {
					prompt := extractLastUserPrompt(transcriptPath)
					if prompt != "" {
						s.state.UpdateUserPrompt(a.SessionID, prompt)
						changed = true
					}
				}
				// Backfill missing last summary (e.g. after cold start / session resume)
				if a.LastSummary == "" && a.LastTrace == "" {
					summary := extractLastAssistantMessage(transcriptPath)
					if summary != "" {
						s.state.UpdateSummary(a.SessionID, summary)
						changed = true
					}
				}
				// Update context usage — detect compaction (tokens decrease)
				ctx := extractContextUsage(transcriptPath)
				if ctx.Tokens > 0 && (ctx.Tokens != a.ContextTokens || ctx.Window != a.ContextWindow) {
					if a.ContextTokens > 0 && ctx.Tokens < a.ContextTokens && (a.State == "done" || a.State == "idle") {
						// Context shrunk on a done agent — compaction detected
						s.state.UpdateSummary(a.SessionID, "Compacted")
					}
					s.state.UpdateContext(a.SessionID, ctx.Tokens, ctx.Window)
					changed = true
				} else if ctx.Tokens == 0 && a.ContextTokens > 0 {
					// extractContextUsage returned 0 — the compact_boundary trimming found
					// no assistant entries after the last compact. Reset HP bar immediately.
					s.state.UpdateContext(a.SessionID, 0, a.ContextWindow)
					if a.LastSummary != "Compacted" {
						s.state.UpdateSummary(a.SessionID, "Compacted")
					}
					changed = true
				}
				// Update trace and activity feed for busy agents
				if a.State == "busy" && len(a.RecentActions) > 0 {
					trace := extractTraceFromTranscript(transcriptPath)
					if trace != "" && trace != a.LastTrace {
						s.state.UpdateTrace(a.SessionID, trace)
						changed = true
					}
					feed := extractActivityFeed(transcriptPath)
					if len(feed) > 0 {
						s.state.UpdateActivityFeed(a.SessionID, feed)
						changed = true
					}
				}
			}
			if changed {
				s.eventBus.Publish("state_update", s.state.GetAgents())
			}
		}
	}()
}

// watcherLoop consumes FileEvents from the store watcher and broadcasts
// state updates via SSE. This is the SINGLE broadcast point for file changes.
func (s *Server) watcherLoop() {
	ch, cleanup := s.storeWatcher.Subscribe()
	defer cleanup()

	for evt := range ch {
		switch {
		case evt.SessionID == "*":
			// Running directory changed — full reload
			s.state.ReloadRunning()
			s.syncSessionMetaToSearch()
			s.applyPendingResumeTaskGroups()
		case strings.HasPrefix(evt.Path, "status") || strings.HasSuffix(evt.Path, ".json"):
			// Status file changed
			s.state.ReloadStatus(evt.Path)
		}
		s.eventBus.Publish("state_update", s.state.GetAgents())
	}
}

// syncSessionMetaToSearch pushes role/project/task_group/profile from running
// sessions into the search index so metadata survives after SessionEnd cleanup.
func (s *Server) syncSessionMetaToSearch() {
	if s.searchSvc == nil {
		return
	}
	for _, a := range s.state.GetAgents() {
		if a.Ephemeral {
			continue
		}
		s.searchSvc.UpdateSessionMeta(a.SessionID, a.ProfileName, a.Role, a.Project, a.TaskGroup)
		// Also update under CCD session ID (running file key may differ from JSONL key)
		if a.CCDSessionID != "" && a.CCDSessionID != a.SessionID {
			s.searchSvc.UpdateSessionMeta(a.CCDSessionID, a.ProfileName, a.Role, a.Project, a.TaskGroup)
		}
	}
}

// applyPendingResumeTaskGroups re-assigns task groups to sessions resumed from PC Box.
func (s *Server) applyPendingResumeTaskGroups() {
	s.pendingResumeSpriteMu.Lock()
	if len(s.pendingResumeTaskGroups) == 0 {
		s.pendingResumeSpriteMu.Unlock()
		return
	}
	pending := make(map[string]string, len(s.pendingResumeTaskGroups))
	for k, v := range s.pendingResumeTaskGroups {
		pending[k] = v
	}
	s.pendingResumeSpriteMu.Unlock()

	agents := s.state.GetAgents()
	for oldSID, taskGroup := range pending {
		for _, a := range agents {
			if a.SessionID == oldSID || a.CCDSessionID == oldSID {
				s.state.SetAgentTaskGroup(a.SessionID, taskGroup)
				s.pendingResumeSpriteMu.Lock()
				delete(s.pendingResumeTaskGroups, oldSID)
				s.pendingResumeSpriteMu.Unlock()
				break
			}
		}
	}
}

// Stop shuts down all background workers.
func (s *Server) Stop() {
	s.storeWatcher.Stop()
	if s.searchSvc != nil {
		s.searchSvc.Close()
	}
}

// --- middleware ---

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- handlers ---

func (s *Server) handleGetSessions(w http.ResponseWriter, r *http.Request) {
	agents := s.state.GetAgents()
	writeJSON(w, agents)
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	agent := s.state.GetAgent(id)
	if agent == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, agent)
}

func (s *Server) handleCreateEphemeral(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID         string `json:"agent_id"`
		AgentType       string `json:"agent_type"`
		ParentSessionID string `json:"parent_session_id"`
		Description     string `json:"description"`
		Prompt          string `json:"prompt"`
		CWD             string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.AgentID == "" {
		http.Error(w, "agent_id required", http.StatusBadRequest)
		return
	}

	ea := EphemeralAgent{
		AgentID:         req.AgentID,
		AgentType:       req.AgentType,
		ParentSessionID: req.ParentSessionID,
		Description:     req.Description,
		Prompt:          req.Prompt,
		State:           "running",
		CWD:             req.CWD,
		CreatedAt:       time.Now().UTC().Format(time.RFC3339),
	}
	if err := s.state.CreateEphemeral(ea); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.eventBus.Publish("ephemeral_start", map[string]any{
		"agent_id":   ea.AgentID,
		"agent_type": ea.AgentType,
		"parent":     ea.ParentSessionID,
	})
	writeJSON(w, map[string]string{"status": "ok", "agent_id": ea.AgentID})
}

func (s *Server) handleCompleteEphemeral(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("id")
	var req struct {
		LastMessage    string `json:"last_message"`
		TranscriptPath string `json:"transcript_path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.state.CompleteEphemeral(agentID, req.LastMessage, req.TranscriptPath); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "ephemeral agent not found", http.StatusNotFound)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	s.eventBus.Publish("ephemeral_stop", map[string]any{
		"agent_id": agentID,
	})
	writeJSON(w, map[string]string{"status": "ok"})
}

func (s *Server) handleDeleteEphemeral(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("id")
	if err := s.state.DeleteEphemeral(agentID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.eventBus.Publish("state_update", s.state.GetAgents())
	writeJSON(w, map[string]string{"status": "ok"})
}

func (s *Server) handleGetProfiles(w http.ResponseWriter, r *http.Request) {
	profiles := s.state.GetProfiles()
	writeJSON(w, profiles)
}

func (s *Server) handleGetProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.fileStore.Projects.List()
	if err != nil {
		writeJSON(w, []any{})
		return
	}
	writeJSON(w, projects)
}

func (s *Server) handleGetRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := s.fileStore.Roles.List()
	if err != nil {
		writeJSON(w, []any{})
		return
	}
	writeJSON(w, roles)
}

func (s *Server) handleLaunchProfile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	profile := s.state.GetProfile(name)
	if profile == nil {
		http.Error(w, "unknown profile", http.StatusNotFound)
		return
	}
	if err := s.terminal.LaunchProfile(name, profile.ITermProfile); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleLaunch accepts any profile string including role@project syntax.
// Unlike handleLaunchProfile, it does not validate against known profiles —
// the shell handles resolution.
func (s *Server) handleLaunch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Profile string `json:"profile"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Profile == "" {
		http.Error(w, "missing profile", http.StatusBadRequest)
		return
	}
	// Try to look up iTerm profile for tab coloring
	itermProfile := ""
	if p := s.state.GetProfile(body.Profile); p != nil {
		itermProfile = p.ITermProfile
	}
	if err := s.terminal.LaunchProfile(body.Profile, itermProfile); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleGetAgentOrder(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.state.GetAgentOrder())
}

func (s *Server) handleSetAgentOrder(w http.ResponseWriter, r *http.Request) {
	var order []string
	if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	s.state.SetAgentOrder(order)
	// Broadcast reordered state
	s.eventBus.Publish("state_update", s.state.GetAgents())
	writeJSON(w, map[string]bool{"ok": true})
}

// ── Grid Layout Persistence ────────────────────────────────

func (s *Server) gridLayoutPath() string {
	return filepath.Join(s.state.dataDir, "grid-layout.json")
}

func (s *Server) gridProfilesDir() string {
	return filepath.Join(s.state.dataDir, "grid-profiles")
}

func (s *Server) handleGetGridLayout(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(s.gridLayoutPath())
	if err != nil {
		writeJSON(w, map[string]any{"settings": nil, "layouts": map[string]any{}})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (s *Server) handleSetGridLayout(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := os.WriteFile(s.gridLayoutPath(), data, 0644); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleListGridProfiles(w http.ResponseWriter, r *http.Request) {
	dir := s.gridProfilesDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeJSON(w, map[string]any{"profiles": []string{}})
		return
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, strings.TrimSuffix(e.Name(), ".json"))
		}
	}
	writeJSON(w, map[string]any{"profiles": names})
}

func (s *Server) handleGetGridProfile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	path := filepath.Join(s.gridProfilesDir(), name+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (s *Server) handleSetGridProfile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	dir := s.gridProfilesDir()
	os.MkdirAll(dir, 0755)
	data, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := os.WriteFile(filepath.Join(dir, name+".json"), data, 0644); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleDeleteGridProfile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	os.Remove(filepath.Join(s.gridProfilesDir(), name+".json"))
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handlePostEvent(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB max
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	var evt HookEvent
	if err := json.Unmarshal(body, &evt); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	agent := s.state.UpdateFromEvent(evt)

	// Broadcast full state to SSE clients (single source of truth)
	agents := s.state.GetAgents()
	s.eventBus.Publish("state_update", agents)

	// Maybe send macOS notification
	s.notifier.MaybeNotify(evt, agent)

	// When an agent transitions to done/idle, nudge if pending messages exist
	if agent != nil && (agent.State == "done" || agent.State == "idle") {
		s.msgSvc.NudgeIfPending(s.resolveToCCDSessionID(evt.SessionID))
	}

	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	svc := s.searchSvc
	if svc == nil {
		http.Error(w, "search unavailable", http.StatusServiceUnavailable)
		return
	}
	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))

	svcResults, total, err := svc.Search(q, limit, offset)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	results := convertSearchResults(svcResults)
	s.enrichDisplayNames(results)
	writeJSON(w, SearchResponse{Results: results, Total: total})
}

func (s *Server) handleSearchRecent(w http.ResponseWriter, r *http.Request) {
	svc := s.searchSvc
	if svc == nil {
		http.Error(w, "search unavailable", http.StatusServiceUnavailable)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	svcResults, err := svc.RecentSessions(limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	results := convertSearchResults(svcResults)
	s.enrichDisplayNames(results)
	writeJSON(w, results)
}

func convertSearchResults(svc []services.SearchResult) []SearchResult {
	results := make([]SearchResult, len(svc))
	for i, r := range svc {
		results[i] = SearchResult{
			SessionID:   r.SessionID,
			ProjectDir:  r.ProjectDir,
			CustomTitle: r.CustomTitle,
			ProfileName: r.ProfileName,
			Role:        r.Role,
			Project:     r.Project,
			Snippet:     r.Snippet,
			CWD:         r.CWD,
			GitBranch:   r.GitBranch,
		}
	}
	return results
}

// enrichDisplayNames overrides custom_title with the display name from
// running files or name-overrides.json. Also populates sprite overrides.
func (s *Server) enrichDisplayNames(results []SearchResult) {
	// Active agent names (highest priority)
	agents := s.state.GetAgents()
	activeNames := make(map[string]string, len(agents))
	for _, a := range agents {
		if a.DisplayName != "" {
			activeNames[a.SessionID] = a.DisplayName
		}
	}

	// Persistent name overrides (for sessions that are no longer active)
	nameOverrides := s.state.GetNameOverrides()

	// Reverse lookup: Claude session ID → name from name-overrides keyed by CCD UUID.
	// The session ID map stores CCD UUID → Claude session ID. We invert it to check
	// if any name override was stored under the CCD UUID for this Claude session.
	sessionIDMap := s.state.GetSessionIDMap()
	reverseMap := make(map[string]string, len(sessionIDMap))
	for ccdSID, claudeSID := range sessionIDMap {
		if name, ok := nameOverrides[ccdSID]; ok {
			reverseMap[claudeSID] = name
		}
	}

	for i := range results {
		sid := results[i].SessionID
		if name, ok := activeNames[sid]; ok {
			results[i].CustomTitle = name
		} else if name, ok := nameOverrides[sid]; ok {
			results[i].CustomTitle = name
		} else if name, ok := reverseMap[sid]; ok {
			results[i].CustomTitle = name
		}
	}
}

func (s *Server) handleResumeSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")

	// Gather metadata from active agent state first, then fall back to search index
	var profileName, role, project, taskGroup string

	agent := s.state.GetAgent(sessionID)
	if agent != nil {
		profileName = agent.ProfileName
		role = agent.Role
		project = agent.Project
		taskGroup = agent.TaskGroup
	}

	// Fill gaps from search index (has metadata synced while session was active)
	if s.searchSvc != nil && (profileName == "" || role == "" || project == "") {
		pn, ro, pr, tg := s.searchSvc.GetSessionMeta(sessionID)
		if profileName == "" {
			profileName = pn
		}
		if role == "" {
			role = ro
		}
		if project == "" {
			project = pr
		}
		if taskGroup == "" {
			taskGroup = tg
		}
	}

	// Build the pokegent target: prefer role@project, fall back to legacy profile
	pokegentTarget := profileName
	if role != "" && project != "" {
		pokegentTarget = role + "@" + project
	} else if project != "" {
		pokegentTarget = "@" + project
	}

	if pokegentTarget == "" {
		// No profile found — resume directly via claude CLI without pokegent wrapping
		log.Printf("resume: no profile for session %s, using bare claude --resume", sessionID)
		safeSession := strings.ReplaceAll(sessionID, `"`, `\"`)
		script := fmt.Sprintf(`
tell application "iTerm2"
	tell current window
		create tab with default profile
		delay 1
		tell current session
			write text "claude --resume %s"
		end tell
	end tell
end tell`, safeSession)
		if err := exec.Command("osascript", "-e", script).Run(); err != nil {
			http.Error(w, fmt.Sprintf("failed to open iTerm2: %v", err), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
		return
	}

	// Store task group for re-assignment after the resumed session registers
	if taskGroup != "" {
		s.pendingResumeSpriteMu.Lock()
		s.pendingResumeTaskGroups[sessionID] = taskGroup
		s.pendingResumeSpriteMu.Unlock()
	}

	compact := r.URL.Query().Get("compact")
	if err := s.terminal.ResumeSession(pokegentTarget, sessionID, compact); err != nil {
		http.Error(w, fmt.Sprintf("failed to open iTerm2: %v", err), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleFocusSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	agent := s.state.GetAgent(sessionID)
	if agent == nil {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}

	if agent.TTY == "" {
		http.Error(w, "no TTY for this agent", http.StatusBadRequest)
		return
	}

	if err := s.terminal.FocusSession(agent.ITermSessionID, agent.TTY); err != nil {
		http.Error(w, fmt.Sprintf("failed to focus: %v", err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleRenameSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")

	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		http.Error(w, "missing name", http.StatusBadRequest)
		return
	}

	agent := s.state.GetAgent(sessionID)
	if agent == nil {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}

	// Update the running file
	s.state.RenameAgent(sessionID, body.Name)

	// Update iTerm2 tab title — fire and forget
	if agent.ITermSessionID != "" || agent.TTY != "" {
		go s.terminal.SetTabName(agent.ITermSessionID, agent.TTY, body.Name)
	}

	// Persist name to the JSONL transcript so it shows correctly in the
	// "Previous sessions" resume page even after the session ends
	go s.persistCustomTitle(sessionID, body.Name)

	// Broadcast updated state
	agents := s.state.GetAgents()
	s.eventBus.Publish("state_update", agents)

	writeJSON(w, map[string]bool{"ok": true})
}

// persistCustomTitle appends a custom-title entry to the session's JSONL
// transcript and updates the search index.
func (s *Server) persistCustomTitle(sessionID, name string) {
	path := s.state.FindTranscriptPath(sessionID)
	transcriptSID := sessionID

	// For clones, the session ID might be the CCD UUID while the JSONL
	// uses the Claude conversation ID. Try looking up the agent's CCDSessionID.
	if path == "" {
		agent := s.state.GetAgent(sessionID)
		if agent != nil && agent.CCDSessionID != "" && agent.CCDSessionID != sessionID {
			path = s.state.FindTranscriptPath(agent.CCDSessionID)
			if path != "" {
				transcriptSID = agent.CCDSessionID
			}
		}
	}

	if path == "" {
		return
	}
	entry := map[string]string{"type": "custom-title", "customTitle": name}
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	f.Write(append(data, '\n'))
	f.Close()

	// Update search index with the transcript's session ID
	if s.searchSvc != nil {
		s.searchSvc.UpdateCustomTitle(transcriptSID, name)
	}
}

func (s *Server) handleSendMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From    string `json:"from"`
		To      string `json:"to"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Content == "" {
		http.Error(w, "missing fields", http.StatusBadRequest)
		return
	}

	fromCCD := s.resolveToCCDSessionID(body.From)
	toCCD := s.resolveToCCDSessionID(body.To)

	// Resolve display names
	fromName, toName := s.resolveDisplayName(body.From, fromCCD), s.resolveDisplayName(body.To, toCCD)

	msg, needsNudge, err := s.msgSvc.Send(fromCCD, fromName, toCCD, toName, body.Content)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.eventBus.Publish("new_message", msg)
	if conns, err := s.msgSvc.GetConnections(); err == nil {
		s.eventBus.Publish("connections_update", conns)
	}
	if needsNudge {
		s.msgSvc.QueueNudge(toCCD)
	}

	writeJSON(w, msg)
}

// handleSendMessageResolved combines agent resolution + message send in one round-trip.
// Accepts from_hint/to_hint (8-char prefixes or full IDs) and resolves server-side.
func (s *Server) handleSendMessageResolved(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FromHint string `json:"from_hint"`
		ToHint   string `json:"to_hint"`
		Content  string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Content == "" || body.ToHint == "" {
		http.Error(w, "missing fields", http.StatusBadRequest)
		return
	}

	fromCCD := s.resolveToCCDSessionID(body.FromHint)
	toCCD := s.resolveToCCDSessionID(body.ToHint)

	// Verify the recipient actually exists as a known agent
	toAgent := s.state.GetAgent(toCCD)
	if toAgent == nil {
		http.Error(w, "no agent found matching \""+body.ToHint+"\"", http.StatusNotFound)
		return
	}

	fromName := s.resolveDisplayName(body.FromHint, fromCCD)
	toName := s.resolveDisplayName(body.ToHint, toCCD)

	msg, needsNudge, err := s.msgSvc.Send(fromCCD, fromName, toCCD, toName, body.Content)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.eventBus.Publish("new_message", msg)
	if conns, err := s.msgSvc.GetConnections(); err == nil {
		s.eventBus.Publish("connections_update", conns)
	}
	if needsNudge {
		s.msgSvc.QueueNudge(toCCD)
	}

	writeJSON(w, map[string]any{
		"message":   msg,
		"to_name":   toName,
		"from_name": fromName,
		"to_id":     toCCD,
		"from_id":   fromCCD,
	})
}

// resolveDisplayName returns the display name for a session ID, trying multiple IDs.
func (s *Server) resolveDisplayName(ids ...string) string {
	for _, id := range ids {
		if a := s.state.GetAgent(id); a != nil {
			if a.DisplayName != "" {
				return a.DisplayName
			}
			return a.ProfileName
		}
	}
	if len(ids) > 0 {
		return ids[0]
	}
	return ""
}

func (s *Server) handleGetActivity(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}

	// Collect activity from all project logs
	activityDir := filepath.Join(s.state.dataDir, "activity")
	entries, err := os.ReadDir(activityDir)
	if err != nil {
		writeJSON(w, []any{})
		return
	}

	type ActivityEntry struct {
		Timestamp string `json:"timestamp"`
		SessionID string `json:"session_id"`
		AgentName string `json:"agent_name"`
		Files     string `json:"files"`
		Summary   string `json:"summary"`
		Raw       string `json:"raw"`
	}

	var all []ActivityEntry
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".log") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(activityDir, e.Name()))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if line == "" {
				continue
			}
			// Parse: [TIMESTAMP] [SESSION_ID] [AGENT_NAME] FILES — SUMMARY
			entry := ActivityEntry{Raw: line}
			rest := line
			if strings.HasPrefix(rest, "[") {
				if idx := strings.Index(rest, "] "); idx > 0 {
					entry.Timestamp = rest[1:idx]
					rest = rest[idx+2:]
				}
			}
			if strings.HasPrefix(rest, "[") {
				if idx := strings.Index(rest, "] "); idx > 0 {
					entry.SessionID = rest[1:idx]
					rest = rest[idx+2:]
				}
			}
			if strings.HasPrefix(rest, "[") {
				if idx := strings.Index(rest, "] "); idx > 0 {
					entry.AgentName = rest[1:idx]
					rest = rest[idx+2:]
				}
			}
			if dashIdx := strings.Index(rest, " — "); dashIdx >= 0 {
				entry.Files = strings.TrimSpace(rest[:dashIdx])
				entry.Summary = rest[dashIdx+len(" — "):]
			} else {
				entry.Files = strings.TrimSpace(rest)
			}
			// Skip entries with no actual file paths
			if entry.Files == "" || strings.HasPrefix(entry.Files, "—") {
				continue
			}
			all = append(all, entry)
		}
	}

	// Return last N entries
	if len(all) > limit {
		all = all[len(all)-limit:]
	}
	writeJSON(w, all)
}

func (s *Server) handleGetMessages(w http.ResponseWriter, r *http.Request) {
	msgs, _ := s.msgSvc.GetHistory()
	writeJSON(w, msgs)
}

func (s *Server) handleGetConnections(w http.ResponseWriter, r *http.Request) {
	conns, _ := s.msgSvc.GetConnections()
	writeJSON(w, conns)
}

func (s *Server) handleGetPending(w http.ResponseWriter, r *http.Request) {
	ccdSID := s.resolveToCCDSessionID(r.PathValue("id"))
	msgs, _ := s.msgSvc.GetPending(ccdSID)
	writeJSON(w, msgs)
}

func (s *Server) handleDeliverPending(w http.ResponseWriter, r *http.Request) {
	ccdSID := s.resolveToCCDSessionID(r.PathValue("id"))
	msgs, _ := s.msgSvc.Deliver(ccdSID)
	writeJSON(w, msgs)
}

func (s *Server) handleConsumePending(w http.ResponseWriter, r *http.Request) {
	ccdSID := s.resolveToCCDSessionID(r.PathValue("id"))
	msgs, _ := s.msgSvc.Consume(ccdSID)
	writeJSON(w, msgs)
}

// resolveSessionID maps a CCD session ID (or prefix) to the Claude session ID.
// Messages are stored under Claude session IDs, but agents may only know their CCD session ID.
func (s *Server) resolveSessionID(id string) string {
	// First check if it directly matches a known agent's session_id
	agents := s.state.GetAgents()
	for _, a := range agents {
		if a.SessionID == id || strings.HasPrefix(a.SessionID, id) {
			return a.SessionID
		}
	}
	// Try matching against ccd_session_id
	for _, a := range agents {
		if a.CCDSessionID != "" && a.CCDSessionID != a.SessionID &&
			(a.CCDSessionID == id || strings.HasPrefix(a.CCDSessionID, id)) {
			return a.SessionID
		}
	}
	// Last resort: scan running files for ccd_session_id field
	// (covers cases where the in-memory state lost the mapping)
	runningDir := filepath.Join(s.state.dataDir, "running")
	entries, err := os.ReadDir(runningDir)
	if err == nil {
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(runningDir, e.Name()))
			if err != nil {
				continue
			}
			var rf struct {
				SessionID    string `json:"session_id"`
				CCDSessionID string `json:"ccd_session_id"`
			}
			if json.Unmarshal(data, &rf) == nil && rf.CCDSessionID != "" {
				if rf.CCDSessionID == id || strings.HasPrefix(rf.CCDSessionID, id) {
					return rf.SessionID
				}
			}
		}
	}
	// Final fallback: check if a mailbox directory starts with the prefix
	msgDir := filepath.Join(s.state.dataDir, "messages")
	msgEntries, err := os.ReadDir(msgDir)
	if err == nil {
		for _, e := range msgEntries {
			if e.IsDir() && strings.HasPrefix(e.Name(), id) {
				return e.Name()
			}
		}
	}
	return id
}

// resolveToCCDSessionID maps any session ID (Claude or CCD, full or prefix) to
// the agent's CCD session ID. Used for message mailbox routing since CCD session
// IDs are unique per agent (even clones), unlike Claude session IDs which are shared.
func (s *Server) resolveToCCDSessionID(id string) string {
	agents := s.state.GetAgents()
	// Check by ccd_session_id first (direct match)
	for _, a := range agents {
		if a.CCDSessionID != "" && (a.CCDSessionID == id || strings.HasPrefix(a.CCDSessionID, id)) {
			return a.CCDSessionID
		}
	}
	// Check by session_id → return ccd_session_id
	for _, a := range agents {
		if a.SessionID == id || strings.HasPrefix(a.SessionID, id) {
			if a.CCDSessionID != "" {
				return a.CCDSessionID
			}
			return a.SessionID // fallback: no ccd_session_id
		}
	}
	return id
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"status": "ok",
		"agents": len(s.state.GetAgents()),
	})
}

func (s *Server) handleSendPrompt(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	var body struct {
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Prompt == "" {
		http.Error(w, "missing prompt", http.StatusBadRequest)
		return
	}

	agent := s.state.GetAgent(sessionID)
	if agent == nil || agent.TTY == "" {
		http.Error(w, "agent not found or no TTY", http.StatusBadRequest)
		return
	}

	go s.terminal.WriteText(agent.ITermSessionID, agent.TTY, body.Prompt)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleCheckMessages(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	agent := s.state.GetAgent(sessionID)
	if agent == nil || agent.TTY == "" {
		http.Error(w, "agent not found or no TTY", http.StatusBadRequest)
		return
	}

	go s.terminal.WriteText(agent.ITermSessionID, agent.TTY, "check messages")
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleShutdownSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	agent := s.state.GetAgent(sessionID)
	if agent == nil || agent.TTY == "" {
		http.Error(w, "agent not found or no TTY", http.StatusBadRequest)
		return
	}

	// Send /exit to gracefully shut down the Claude session, then close the tab
	itermSID := agent.ITermSessionID
	tty := agent.TTY
	go func() {
		s.terminal.WriteText(itermSID, tty, "/exit")
		// Wait for Claude to exit, then close the iTerm tab
		time.Sleep(2 * time.Second)
		s.terminal.CloseSession(itermSID, tty)
	}()
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleReleaseTaskGroup(w http.ResponseWriter, r *http.Request) {
	groupName := r.PathValue("name")
	if groupName == "" {
		http.Error(w, "missing group name", http.StatusBadRequest)
		return
	}

	agents := s.state.GetAgentsByTaskGroup(groupName)
	if len(agents) == 0 {
		http.Error(w, "no agents in group", http.StatusNotFound)
		return
	}

	var released []string
	for _, agent := range agents {
		if agent.Ephemeral {
			// Dismiss completed ephemerals immediately
			if agent.State == "done" {
				s.state.DeleteEphemeral(agent.SessionID)
			}
			continue
		}
		if agent.TTY == "" {
			continue
		}
		itermSID := agent.ITermSessionID
		tty := agent.TTY
		go func() {
			s.terminal.WriteText(itermSID, tty, "/exit")
			time.Sleep(2 * time.Second)
			s.terminal.CloseSession(itermSID, tty)
		}()
		released = append(released, agent.SessionID)
	}

	s.eventBus.Publish("state_update", s.state.GetAgents())
	writeJSON(w, map[string]any{"ok": true, "released": released, "count": len(released)})
}

func (s *Server) handleGetTaskGroupSessions(w http.ResponseWriter, r *http.Request) {
	groupName := r.PathValue("name")
	if groupName == "" {
		http.Error(w, "missing group name", http.StatusBadRequest)
		return
	}
	if s.searchSvc == nil {
		http.Error(w, "search unavailable", http.StatusServiceUnavailable)
		return
	}
	results, err := s.searchSvc.SessionsByTaskGroup(groupName)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Mark which sessions are currently active
	activeAgents := s.state.GetAgents()
	activeIDs := make(map[string]bool, len(activeAgents))
	for _, a := range activeAgents {
		activeIDs[a.SessionID] = true
		if a.CCDSessionID != "" {
			activeIDs[a.CCDSessionID] = true
		}
	}

	type sessionInfo struct {
		services.SearchResult
		Active bool `json:"active"`
	}
	out := make([]sessionInfo, len(results))
	for i, r := range results {
		out[i] = sessionInfo{SearchResult: r, Active: activeIDs[r.SessionID]}
	}
	writeJSON(w, out)
}

func (s *Server) handleUploadImage(w http.ResponseWriter, r *http.Request) {
	sessionID := s.resolveSessionID(r.PathValue("id"))

	// Read image data (max 10MB)
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		http.Error(w, "invalid upload", http.StatusBadRequest)
		return
	}
	file, _, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "missing image field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, 10<<20))
	if err != nil {
		http.Error(w, "read error", http.StatusInternalServerError)
		return
	}

	// Find the image cache dir and next number
	home, _ := os.UserHomeDir()
	cacheDir := filepath.Join(home, ".claude", "image-cache", sessionID)
	os.MkdirAll(cacheDir, 0755)

	// Find next available number
	num := 1
	for {
		if _, err := os.Stat(filepath.Join(cacheDir, fmt.Sprintf("%d.png", num))); os.IsNotExist(err) {
			break
		}
		num++
	}

	imgPath := filepath.Join(cacheDir, fmt.Sprintf("%d.png", num))
	if err := os.WriteFile(imgPath, data, 0644); err != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}

	// Return the file path — the agent can read it directly via the Read tool.
	// Claude Code's [Image #N] syntax only works for images pasted through its
	// own terminal paste handler, not for externally written files.
	writeJSON(w, map[string]any{"image_num": num, "path": imgPath, "ref": fmt.Sprintf("[Image: %s]", imgPath)})
}

func (s *Server) handleGetTranscript(w http.ResponseWriter, r *http.Request) {
	sessionID := s.resolveSessionID(r.PathValue("id"))
	path := s.state.FindTranscriptPath(sessionID)
	if path == "" {
		writeJSON(w, store.TranscriptPage{})
		return
	}

	tail := 100
	if v := r.URL.Query().Get("tail"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			tail = n
		}
	}
	afterUUID := r.URL.Query().Get("after")

	reader := store.NewTranscriptReader(s.state.claudeProjectDir)
	page := reader.ParseTranscript(path, tail, afterUUID)
	writeJSON(w, page)
}

func (s *Server) handleSessionPreview(w http.ResponseWriter, r *http.Request) {
	sessionID := s.resolveSessionID(r.PathValue("id"))
	path := s.state.FindTranscriptPath(sessionID)
	if path == "" {
		writeJSON(w, map[string]string{"user_prompt": "", "last_summary": ""})
		return
	}
	userPrompt, lastSummary := extractLastMessages(path)
	writeJSON(w, map[string]string{
		"user_prompt":  userPrompt,
		"last_summary": lastSummary,
	})
}

func (s *Server) handleCloneSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	agent := s.state.GetAgent(sessionID)
	if agent == nil {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}

	profileName := agent.ProfileName
	if profileName == "" {
		http.Error(w, "cannot determine profile", http.StatusBadRequest)
		return
	}

	// Open a new iTerm2 tab and launch a forked clone via pokegents
	if err := s.terminal.CloneSession(profileName, sessionID[:8]); err != nil {
		http.Error(w, fmt.Sprintf("failed: %v", err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleSetSprite(w http.ResponseWriter, r *http.Request) {
	sessionID := s.resolveSessionID(r.PathValue("id"))
	var body struct {
		Sprite string `json:"sprite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Sprite == "" {
		http.Error(w, "missing sprite", http.StatusBadRequest)
		return
	}

	if err := s.state.SetAgentSprite(sessionID, body.Sprite); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	s.eventBus.Publish("state_update", s.state.GetAgents())
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleSetRole(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	var body struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if body.Role != "" {
		if _, err := s.fileStore.Roles.Get(body.Role); err != nil {
			http.Error(w, "unknown role: "+body.Role, http.StatusBadRequest)
			return
		}
	}
	s.state.SetAgentRole(sessionID, body.Role)
	s.eventBus.Publish("state_update", s.state.GetAgents())
	status := s.relaunchIfIdle(sessionID)
	writeJSON(w, map[string]string{"status": status, "role": body.Role})
}

func (s *Server) handleSetProject(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	var body struct {
		Project string `json:"project"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if body.Project != "" {
		if _, err := s.fileStore.Projects.Get(body.Project); err != nil {
			http.Error(w, "unknown project: "+body.Project, http.StatusBadRequest)
			return
		}
	}
	s.state.SetAgentProject(sessionID, body.Project)
	s.eventBus.Publish("state_update", s.state.GetAgents())
	status := s.relaunchIfIdle(sessionID)
	writeJSON(w, map[string]string{"status": status, "project": body.Project})
}

func (s *Server) handleSetTaskGroup(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	var body struct {
		TaskGroup string `json:"task_group"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	sessionID = s.resolveSessionID(sessionID)
	if err := s.state.SetAgentTaskGroup(sessionID, body.TaskGroup); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	s.eventBus.Publish("state_update", s.state.GetAgents())
	writeJSON(w, map[string]string{"status": "updated", "task_group": body.TaskGroup})
}

// relaunchIfIdle stops and relaunches an agent with its current role@project.
// Returns "relaunching" (immediate), "queued" (busy), or "updated" (no relaunch needed).
func (s *Server) relaunchIfIdle(sessionID string) string {
	agent := s.state.GetAgent(sessionID)
	if agent == nil || (agent.Role == "" && agent.Project == "") {
		return "updated"
	}

	// If project is empty, use the agent's legacy profile name as project fallback
	// (e.g. assigning role "pm" to a legacy "personal" agent → pm@personal)
	project := agent.Project
	if project == "" {
		project = agent.ProfileName
	}
	target := composeTarget(agent.Role, project, agent.ProfileName)
	cmd := fmt.Sprintf("pokegent %s -r %s", target, sessionID)

	if agent.State == "done" || agent.State == "idle" {
		if agent.ITermSessionID != "" || agent.TTY != "" {
			go func() {
				s.terminal.WriteText(agent.ITermSessionID, agent.TTY, "/exit")
				time.Sleep(2 * time.Second)
				s.terminal.WriteText(agent.ITermSessionID, agent.TTY, cmd)
			}()
		}
		return "relaunching"
	}

	// Busy — queue for later
	s.state.SetPendingRelaunch(sessionID, cmd)
	return "queued"
}

func composeTarget(role, project, fallback string) string {
	if role != "" && project != "" {
		return role + "@" + project
	}
	if project != "" {
		return "@" + project
	}
	if role != "" {
		return role + "@"
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}
