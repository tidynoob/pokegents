package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
	dataDir := filepath.Join(home, ".ccsession")

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
		mux:          http.NewServeMux(),
		port:         cfg.Port,
		webDir:       cfg.WebDir,
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
	s.mux.HandleFunc("POST /api/sessions/{id}/prompt", s.handleSendPrompt)
	s.mux.HandleFunc("POST /api/sessions/{id}/check-messages", s.handleCheckMessages)
	s.mux.HandleFunc("POST /api/sessions/{id}/clone", s.handleCloneSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/shutdown", s.handleShutdownSession)
	s.mux.HandleFunc("GET /api/sprite-overrides", s.handleGetSpriteOverrides)
	s.mux.HandleFunc("GET /api/profiles", s.handleGetProfiles)
	s.mux.HandleFunc("POST /api/profiles/{name}/launch", s.handleLaunchProfile)
	s.mux.HandleFunc("GET /api/agent-order", s.handleGetAgentOrder)
	s.mux.HandleFunc("PUT /api/agent-order", s.handleSetAgentOrder)
	s.mux.HandleFunc("GET /api/events", s.eventBus.ServeSSE)
	s.mux.HandleFunc("POST /api/events", s.handlePostEvent)
	s.mux.HandleFunc("GET /api/search", s.handleSearch)
	s.mux.HandleFunc("GET /api/search/recent", s.handleSearchRecent)
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("POST /api/messages", s.handleSendMessage)
	s.mux.HandleFunc("GET /api/messages", s.handleGetMessages)
	s.mux.HandleFunc("GET /api/messages/connections", s.handleGetConnections)
	s.mux.HandleFunc("GET /api/messages/pending/{id}", s.handleGetPending)
	s.mux.HandleFunc("POST /api/messages/deliver/{id}", s.handleDeliverPending)
	s.mux.HandleFunc("POST /api/messages/consume/{id}", s.handleConsumePending)
	s.mux.HandleFunc("GET /api/activity", s.handleGetActivity)

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

	// Start search indexer
	if s.searchSvc != nil {
		s.searchSvc.StartBackgroundIndexer(5 * time.Minute)
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
				if ctx.Tokens > 0 && ctx.Tokens != a.ContextTokens {
					if a.ContextTokens > 0 && ctx.Tokens < a.ContextTokens && (a.State == "done" || a.State == "idle") {
						// Context shrunk on a done agent — compaction detected
						s.state.UpdateSummary(a.SessionID, "Compacted")
					}
					s.state.UpdateContext(a.SessionID, ctx.Tokens, ctx.Window)
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
		case strings.HasPrefix(evt.Path, "status") || strings.HasSuffix(evt.Path, ".json"):
			// Status file changed
			s.state.ReloadStatus(evt.Path)
		}
		s.eventBus.Publish("state_update", s.state.GetAgents())
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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

func (s *Server) handleGetProfiles(w http.ResponseWriter, r *http.Request) {
	profiles := s.state.GetProfiles()
	writeJSON(w, profiles)
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

	// Sprite overrides
	spriteOverrides := s.loadSpriteOverrides()

	for i := range results {
		sid := results[i].SessionID
		if name, ok := activeNames[sid]; ok {
			results[i].CustomTitle = name
		} else if name, ok := nameOverrides[sid]; ok {
			results[i].CustomTitle = name
		} else if name, ok := reverseMap[sid]; ok {
			results[i].CustomTitle = name
		}
		if sprite, ok := spriteOverrides[sid]; ok {
			results[i].SpriteOverride = sprite
		}
	}
}

func (s *Server) handleResumeSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")

	// Find profile for this session
	agent := s.state.GetAgent(sessionID)
	profileName := ""
	if agent != nil {
		profileName = agent.ProfileName
	}

	if profileName == "" {
		// Try to find from search index
		if s.searchSvc != nil {
			profileName = s.searchSvc.GetProfileName(sessionID)
		}
	}

	if profileName == "" {
		http.Error(w, "cannot determine profile for session", http.StatusBadRequest)
		return
	}

	if err := s.terminal.ResumeSession(profileName, sessionID); err != nil {
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

func (s *Server) spriteOverridesPath() string {
	return filepath.Join(s.state.dataDir, "sprite-overrides.json")
}

func (s *Server) loadSpriteOverrides() map[string]string {
	data, err := os.ReadFile(s.spriteOverridesPath())
	if err != nil {
		return map[string]string{}
	}
	var m map[string]string
	if json.Unmarshal(data, &m) != nil {
		return map[string]string{}
	}
	return m
}

func (s *Server) handleSetSprite(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	var body struct {
		Sprite string `json:"sprite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Sprite == "" {
		http.Error(w, "missing sprite", http.StatusBadRequest)
		return
	}

	overrides := s.loadSpriteOverrides()
	overrides[sessionID] = body.Sprite
	data, _ := json.Marshal(overrides)
	os.WriteFile(s.spriteOverridesPath(), data, 0644)

	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleGetSpriteOverrides(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.loadSpriteOverrides())
}

func writeJSON(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}
