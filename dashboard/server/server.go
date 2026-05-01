package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
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
	dataDir   string
	chatMgr    *ChatManager
	runtimes   runtimeRegistry
	mux        *http.ServeMux
	httpServer *http.Server
	port       int
	webDir     string

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
	// One-time migration: re-key mailboxes from ccd_session_id → pokegent_id.
	// Idempotent — safe across restarts. (See mailbox_migration.go for the
	// removal-when-fleet-migrated note.)
	migrateMailboxesToPokegentID(cfg.DataDir)
	// One-time fixup: chat status files written before the runtime-parity
	// refactor stored pokegent_id in the `session_id` field, which made
	// state.go's status lookup miss for chat agents (causing last_summary
	// to flicker as the JSONL backfill briefly populated it then got
	// clobbered by rebuildAgents). Idempotent.
	fixupStatusFiles(cfg.DataDir)

	fileStore := store.NewFileStore(cfg.DataDir)
	state := NewStateManagerWithStore(fileStore, cfg.DataDir, cfg.ClaudeProjectDir)
	eventBus := NewEventBus()
	notifier := NewNotifier(cfg.WebDir, cfg.DataDir)
	terminal := NewTerminal()

	// Services. Wake callback is wired below once the runtime registry is
	// built — using a setter avoids reordering the rest of bootstrap and
	// lets the closure capture `s` so it always sees the latest registry.
	msgSvc := services.NewMessagingService(
		fileStore.Messages,
		nil,
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
		dataDir:      cfg.DataDir,
		mux:                  http.NewServeMux(),
		port:                 cfg.Port,
		webDir:               cfg.WebDir,
		pendingResumeTaskGroups: make(map[string]string),
	}

	// Phase 3: chat-backed pokegent supervisor.
	s.chatMgr = NewChatManager(cfg.DataDir, func() {
		eventBus.Publish("state_update", state.GetAgents())
	}, eventBus)

	// Runtime registry — every backend implements the same interface; HTTP
	// handlers dispatch through this map keyed by `agent.interface`.
	s.runtimes = runtimeRegistry{
		"iterm2": NewITerm2Runtime(state, terminal),
		"chat":   NewChatRuntime(s.chatMgr),
	}

	// Wire the messaging-service wake callback now that the registry exists.
	// Dispatches per-agent based on `agent.Interface` — iterm2 types the
	// trigger phrase into the TTY, chat sends an ACP prompt. This was the
	// missing piece that broke nudges for chat agents.
	msgSvc.SetWake(func(pgid string) error {
		a := state.GetAgent(pgid)
		if a == nil {
			return nil
		}
		rt, err := s.runtimes.For(a.Interface)
		if err != nil {
			return err
		}
		return rt.CheckMessages(context.Background(), pgid)
	})

	s.routes()
	return s, nil
}

func (s *Server) routes() {
	// API routes
	s.mux.HandleFunc("GET /api/sessions", s.handleGetSessions)
	s.mux.HandleFunc("GET /api/sessions/{id}", s.handleGetSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/focus", s.handleFocusSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/rename", s.handleRenameSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/sprite", s.handleSetSprite)
	s.mux.HandleFunc("POST /api/sessions/{id}/role", s.handleSetRole)
	s.mux.HandleFunc("POST /api/sessions/{id}/project", s.handleSetProject)
	s.mux.HandleFunc("POST /api/sessions/{id}/task-group", s.handleSetTaskGroup)
	s.mux.HandleFunc("POST /api/sessions/{id}/prompt", s.handleSendPrompt)
	s.mux.HandleFunc("POST /api/sessions/{id}/cancel", s.handleCancelSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/runtime-config", s.handleSetRuntimeConfig)
	s.mux.HandleFunc("POST /api/sessions/{id}/check-messages", s.handleCheckMessages)
	s.mux.HandleFunc("POST /api/sessions/{id}/clone", s.handleCloneSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/shutdown", s.handleShutdownSession)
	s.mux.HandleFunc("POST /api/sessions/{id}/debug/force-idle", s.handleDebugForceIdle)
	s.mux.HandleFunc("POST /api/sessions/{id}/debug/respawn", s.handleDebugRespawn)
	s.mux.HandleFunc("GET /api/runtimes", s.handleListRuntimes)
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
	// Phase 2: unified launch endpoint. Single entry point regardless of interface.
	s.mux.HandleFunc("POST /api/pokegents/launch", s.handleUnifiedLaunch)

	// Chat-only endpoints — streaming and permission UI are genuinely
	// chat-runtime-specific (no iterm2 equivalent). The prompt/cancel/
	// delete operations dispatch via the runtime registry under
	// `/api/sessions/{id}/...` and are NOT duplicated here.
	s.mux.HandleFunc("GET /api/chat/{id}/stream", s.handleChatStream)
	s.mux.HandleFunc("POST /api/chat/{id}/permission/{request_id}", s.handleChatPermission)
	// Phase 1: event ring buffer — cursor-based fetch for reconnecting clients.
	s.mux.HandleFunc("GET /api/chat/{id}/events", s.handleChatEvents)
	// Phase 1: prompt queue — inspect pending queued prompts.
	s.mux.HandleFunc("GET /api/sessions/{id}/queue", s.handleGetQueue)

	// Phase 4: interface migration — swap an agent's runtime backend without
	// changing identity (pokegent_id, session_id, mailbox all preserved).
	s.mux.HandleFunc("POST /api/sessions/{id}/migrate", s.handleMigrateInterface)
	s.mux.HandleFunc("GET /api/agent-order", s.handleGetAgentOrder)
	s.mux.HandleFunc("PUT /api/agent-order", s.handleSetAgentOrder)
	s.mux.HandleFunc("GET /api/events", s.eventBus.ServeSSE)
	s.mux.HandleFunc("POST /api/events", s.handlePostEvent)
	// Compat: pokegent.sh's resume path reads sprite + pokegent_id by session_id.
	// Thin shim over the new pokegent-centric data.
	s.mux.HandleFunc("GET /api/sessions/{id}/meta", s.handleGetSessionMeta)

	// Pokegent-centric PC box
	s.mux.HandleFunc("GET /api/pokegents/pc-box", s.handleListPokegents)
	s.mux.HandleFunc("GET /api/pokegents/search", s.handleSearchPokegents)
	s.mux.HandleFunc("GET /api/pokegents/{id}", s.handleGetPokegent)
	s.mux.HandleFunc("POST /api/pokegents/{id}/revive", s.handleRevivePokegent)
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
	s.mux.HandleFunc("GET /api/town-mask", s.handleGetTownMask)
	s.mux.HandleFunc("PUT /api/town-mask", s.handleSetTownMask)
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
		// Wire pokegent resolver: indexer attributes JSONL → pokegent_id via
		// session_transcripts lookup or the legacy session-id-map fallback.
		s.searchSvc.SetPokegentResolver(func(sessionID string) string {
			if pgid := s.searchSvc.GetPokegentIDForSession(sessionID); pgid != "" {
				return pgid
			}
			// Fallback: consult live state (agent currently running with this sid)
			if a := s.state.GetAgent(sessionID); a != nil && a.PokegentID != "" {
				return a.PokegentID
			}
			// Last resort: legacy session-id-map (ccd_sid → claude_sid; ccd_sid = pokegent_id)
			for ccdSID, claudeSID := range s.state.GetSessionIDMap() {
				if claudeSID == sessionID {
					return ccdSID
				}
			}
			return ""
		})
		// One-time migration from legacy session_meta → new tables
		s.migratePokegentsIndex()
		s.searchSvc.StartBackgroundIndexer(5*time.Minute, s.syncSessionMetaToSearch)
	}

	// Start transcript poller for live trace updates
	s.startTracePoller()

	// Re-attach orphaned chat agents (dashboard crash recovery). Async so
	// it doesn't block the HTTP server from coming up — chat agents
	// briefly show "connecting" until their fresh ACP backends finish
	// session/load (typically 2-5s per agent).
	go s.reattachChatSessions()

	addr := fmt.Sprintf(":%d", s.port)
	s.httpServer = &http.Server{
		Addr:    addr,
		Handler: s.corsMiddleware(s.mux),
	}
	log.Printf("dashboard server listening on http://localhost%s", addr)
	if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
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
					if a.ContextTokens > 0 && ctx.Tokens < a.ContextTokens && a.State == "idle" {
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
				// Detect Ctrl+C interrupt: agent is busy but transcript shows "[Request interrupted by user]"
				if a.State == "busy" && isTranscriptInterrupted(transcriptPath) {
					s.state.TransitionState(a.SessionID, "idle", "interrupted")
					changed = true
					continue
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
		s.searchSvc.UpdateSessionMeta(a.SessionID, a.ProfileName, a.Role, a.Project, a.TaskGroup, a.Sprite, a.PokegentID)
		// Also bind session_id → pokegent_id in the new transcripts table so the
		// PC box / resolver can attribute without waiting for the 5-min indexer
		if a.PokegentID != "" && a.SessionID != "" {
			s.searchSvc.UpsertTranscript(services.TranscriptSummary{
				SessionID: a.SessionID,
			}, a.PokegentID)
		}
	}
	// Keep pokegents_meta fresh too (sprite/name edits in the identity store)
	s.upsertIdentitiesToIndex()
}

// migratePokegentsIndex runs the one-time migration from legacy session_meta to
// the new session_transcripts + pokegents_meta tables. Also performs a continuous
// upsert of identity-store data so live sprite/name changes reach the PC box.
func (s *Server) migratePokegentsIndex() {
	if s.searchSvc == nil {
		return
	}
	idents := s.state.GetIdentities()
	snapshots := make([]services.IdentitySnapshot, 0, len(idents))
	for _, id := range idents {
		if id == nil {
			continue
		}
		snapshots = append(snapshots, services.IdentitySnapshot{
			PokegentID:  id.PokegentID,
			DisplayName: id.DisplayName,
			Sprite:      id.Sprite,
			Role:        id.Role,
			Project:     id.Project,
			TaskGroup:   id.TaskGroup,
			ProfileName: id.Profile,
			CreatedAt:   id.CreatedAt,
		})
	}
	s.searchSvc.MigrateFromSessionMeta(snapshots, s.state.GetSessionIDMap())
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

// Stop shuts down all background workers and cleanly terminates every
// active chat session. Order matters here:
//   1. httpServer.Shutdown — drain in-flight HTTP requests first so they
//      complete normally rather than 500ing on a closed chat manager.
//   2. chatMgr.CloseAll — kill ACP subprocesses and wait for cmd.Wait
//      goroutines. Without this, ACP processes would survive as PPID=1
//      orphans that the next dashboard couldn't re-attach to via stdio.
//   3. storeWatcher.Stop — only after chat goroutines stop publishing
//      state_updates that consumers may have already disconnected from.
//   4. searchSvc.Close — last because indexer reads from running state.
func (s *Server) Stop() {
	if s.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.httpServer.Shutdown(ctx)
	}
	if s.chatMgr != nil {
		log.Printf("shutdown: closing all chat sessions")
		s.chatMgr.CloseAll(5 * time.Second)
	}
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

// handleGetSessionMeta is a compat shim for pokegent.sh's resume sprite lookup.
// Resolves a Claude session_id to its owning pokegent via session_transcripts,
// then returns that pokegent's identity fields.
func (s *Server) handleGetSessionMeta(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	// Live agent first
	if agent := s.state.GetAgent(sessionID); agent != nil {
		writeJSON(w, map[string]string{
			"sprite":       agent.Sprite,
			"role":         agent.Role,
			"project":      agent.Project,
			"task_group":   agent.TaskGroup,
			"profile_name": agent.ProfileName,
			"pokegent_id":  agent.PokegentID,
		})
		return
	}
	// Dead agent: session_transcripts → pokegents_meta
	if s.searchSvc != nil {
		if pgid := s.searchSvc.GetPokegentIDForSession(sessionID); pgid != "" {
			if summary, err := s.searchSvc.GetPokegentSummary(pgid); err == nil && summary != nil {
				writeJSON(w, map[string]string{
					"sprite":       summary.Sprite,
					"role":         summary.Role,
					"project":      summary.Project,
					"task_group":   summary.TaskGroup,
					"profile_name": summary.ProfileName,
					"pokegent_id":  summary.PokegentID,
				})
				return
			}
		}
	}
	writeJSON(w, map[string]string{})
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
	if err := s.terminal.LaunchProfile(LaunchOptions{Profile: name, ITermProfile: profile.ITermProfile}); err != nil {
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
		Profile   string `json:"profile"`
		TaskGroup string `json:"task_group,omitempty"`
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
	if err := s.terminal.LaunchProfile(LaunchOptions{
		Profile:      body.Profile,
		ITermProfile: itermProfile,
		TaskGroup:    body.TaskGroup,
	}); err != nil {
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

// Town walkable-mask persistence — stores the user's hand-tuned collision grid
// at ~/.pokegents/town-mask.json. The frontend's debug-mode click-to-toggle
// PUTs here. The file is human-readable so the source `TOWN_MASK` constant in
// TownView.tsx can be updated by hand once the user is happy with the layout.
func (s *Server) townMaskPath() string {
	return filepath.Join(s.state.dataDir, "town-mask.json")
}

func (s *Server) handleGetTownMask(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(s.townMaskPath())
	if err != nil {
		// 204 = "no saved mask, frontend should use its hardcoded default"
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (s *Server) handleSetTownMask(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := os.WriteFile(s.townMaskPath(), data, 0644); err != nil {
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
	s.eventBus.Publish("state_update", s.state.GetAgents())

	// Maybe send macOS notification
	s.notifier.MaybeNotify(evt, agent)

	// When an agent transitions to done/idle, nudge if pending messages exist
	if agent != nil && agent.State == "idle" {
		s.msgSvc.NudgeIfPending(s.resolveToPokegentID(evt.SessionID))
	}

	writeJSON(w, map[string]bool{"ok": true})
}

// ── Pokegent-centric PC box handlers ────────────────────────

func (s *Server) handleListPokegents(w http.ResponseWriter, r *http.Request) {
	if s.searchSvc == nil {
		http.Error(w, "search unavailable", http.StatusServiceUnavailable)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 100
	}
	// Oversample so alive-agent filtering doesn't undercut the visible count.
	fetchLimit := limit + 50
	list, err := s.searchSvc.ListPokegents(fetchLimit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	alive := make(map[string]bool)
	for _, a := range s.state.GetAgents() {
		if a.PokegentID != "" {
			alive[a.PokegentID] = true
		}
	}
	filtered := make([]services.PokegentSummary, 0, len(list))
	for _, p := range list {
		if alive[p.PokegentID] {
			continue
		}
		filtered = append(filtered, p)
		if len(filtered) >= limit {
			break
		}
	}
	writeJSON(w, map[string]any{"pokegents": filtered})
}

func (s *Server) handleSearchPokegents(w http.ResponseWriter, r *http.Request) {
	if s.searchSvc == nil {
		http.Error(w, "search unavailable", http.StatusServiceUnavailable)
		return
	}
	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, total, err := s.searchSvc.SearchPokegents(q, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"pokegents": list, "total": total})
}

func (s *Server) handleGetPokegent(w http.ResponseWriter, r *http.Request) {
	if s.searchSvc == nil {
		http.Error(w, "search unavailable", http.StatusServiceUnavailable)
		return
	}
	pgid := r.PathValue("id")
	summary, err := s.searchSvc.GetPokegentSummary(pgid)
	if err != nil || summary == nil {
		http.Error(w, "pokegent not found", http.StatusNotFound)
		return
	}
	writeJSON(w, summary)
}

// handleRevivePokegent spawns a fresh Claude session under the given pokegent_id,
// resuming the most recent transcript.
func (s *Server) handleRevivePokegent(w http.ResponseWriter, r *http.Request) {
	if s.searchSvc == nil {
		http.Error(w, "search unavailable", http.StatusServiceUnavailable)
		return
	}
	pgid := r.PathValue("id")
	summary, err := s.searchSvc.GetPokegentSummary(pgid)
	if err != nil || summary == nil {
		http.Error(w, "pokegent not found", http.StatusNotFound)
		return
	}
	if summary.LatestSession.SessionID == "" {
		http.Error(w, "no transcripts to resume", http.StatusBadRequest)
		return
	}

	profileName := summary.ProfileName
	role := summary.Role
	project := summary.Project
	pokegentTarget := profileName
	if role != "" && project != "" {
		pokegentTarget = role + "@" + project
	} else if project != "" {
		pokegentTarget = "@" + project
	}
	if pokegentTarget == "" {
		http.Error(w, "pokegent has no profile/project — cannot determine launch target", http.StatusBadRequest)
		return
	}

	// Stash task group for re-assignment after the resumed session registers
	if summary.TaskGroup != "" {
		s.pendingResumeSpriteMu.Lock()
		s.pendingResumeTaskGroups[summary.LatestSession.SessionID] = summary.TaskGroup
		s.pendingResumeSpriteMu.Unlock()
	}

	// Dispatch by the agent's stored interface. Chat-mode revives spawn a
	// fresh ACP backend resuming the same Claude session_id; iterm2-mode
	// revives open a new iTerm2 tab via pokegent.sh's --resume flow.
	// Without this branch every revive hard-coded to iterm2 — even for
	// agents whose identity says interface=chat — forcing the user to
	// migrate manually after every revive.
	ident, _ := s.fileStore.Agents.Get(pgid)
	wantChat := ident != nil && ident.Interface == "chat"

	if wantChat {
		// Pre-write running file so the dashboard sees the agent immediately.
		// chatMgr.Launch's patchRunningFileChat updates fields in-place; if
		// the file's missing it's a no-op and the agent stays invisible.
		// Pull Model/Effort from identity when present so they survive
		// revive (relaunchChatSession then defaults to role/project config
		// if these are still empty).
		rsModel, rsEffort := "", ""
		if ident != nil {
			rsModel = ident.Model
			rsEffort = ident.Effort
		}
		rs := store.RunningSession{
			Profile:     summary.ProfileName,
			PokegentID:  pgid,
			SessionID:   summary.LatestSession.SessionID,
			DisplayName: summary.DisplayName,
			Sprite:      summary.Sprite,
			Role:        summary.Role,
			Project:     summary.Project,
			TaskGroup:   summary.TaskGroup,
			Model:       rsModel,
			Effort:      rsEffort,
			Interface:   "chat",
		}
		if _, err := writePlaceholderRunningFile(filepath.Join(s.dataDir, "running"), rs); err != nil {
			http.Error(w, "pre-write running file: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if err := s.relaunchChatSession(rs); err != nil {
			// Roll back the placeholder file on launch failure.
			path := filepath.Join(s.dataDir, "running",
				fmt.Sprintf("%s-%s.json", rs.Profile, rs.PokegentID))
			_ = os.Remove(path)
			http.Error(w, fmt.Sprintf("chat revive failed: %v", err), http.StatusInternalServerError)
			return
		}
		s.eventBus.Publish("state_update", s.state.GetAgents())
		writeJSON(w, map[string]bool{"ok": true})
		return
	}

	compact := r.URL.Query().Get("compact")
	if err := s.terminal.ResumePokegent(pokegentTarget, summary.LatestSession.SessionID, pgid, compact); err != nil {
		http.Error(w, fmt.Sprintf("failed to open terminal: %v", err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// upsertIdentitiesToIndex refreshes pokegents_meta from the in-memory identity store.
// Called before PC box reads so sprite/name changes are visible immediately.
func (s *Server) upsertIdentitiesToIndex() {
	if s.searchSvc == nil {
		return
	}
	idents := s.state.GetIdentities()
	snapshots := make([]services.IdentitySnapshot, 0, len(idents))
	for _, id := range idents {
		if id == nil || id.PokegentID == "" {
			continue
		}
		snapshots = append(snapshots, services.IdentitySnapshot{
			PokegentID:  id.PokegentID,
			DisplayName: id.DisplayName,
			Sprite:      id.Sprite,
			Role:        id.Role,
			Project:     id.Project,
			TaskGroup:   id.TaskGroup,
			ProfileName: id.Profile,
			CreatedAt:   id.CreatedAt,
		})
	}
	s.searchSvc.UpsertPokegentsMeta(snapshots)
}

// ── End pokegent-centric handlers ───────────────────────────

func (s *Server) handleFocusSession(w http.ResponseWriter, r *http.Request) {
	agent, rt, done := s.resolveAgentAndRuntime(w, r)
	if done {
		return
	}
	if !rt.Capabilities().CanFocus {
		// Chat agents have no terminal-tab to focus; the dashboard's
		// frontend opens the side ChatPanel itself via a CustomEvent.
		// Return 200 so the frontend's optimistic click handler doesn't
		// surface an error to the user.
		writeJSON(w, map[string]bool{"ok": true, "focusable": false})
		return
	}
	if err := rt.Focus(r.Context(), agent.PokegentID); err != nil {
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
	s.eventBus.Publish("state_update", s.state.GetAgents())

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

	fromPGID := s.resolveToPokegentID(body.From)
	toPGID := s.resolveToPokegentID(body.To)

	// Resolve display names
	fromName, toName := s.resolveDisplayName(body.From, fromPGID), s.resolveDisplayName(body.To, toPGID)

	msg, needsNudge, err := s.msgSvc.Send(fromPGID, fromName, toPGID, toName, body.Content)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.eventBus.Publish("new_message", msg)
	if conns, err := s.msgSvc.GetConnections(); err == nil {
		s.eventBus.Publish("connections_update", conns)
	}
	if needsNudge {
		s.msgSvc.QueueNudge(toPGID)
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

	fromPGID := s.resolveToPokegentID(body.FromHint)
	toPGID := s.resolveToPokegentID(body.ToHint)

	// Verify the recipient actually exists as a known agent
	toAgent := s.state.GetAgent(toPGID)
	if toAgent == nil {
		http.Error(w, "no agent found matching \""+body.ToHint+"\"", http.StatusNotFound)
		return
	}

	fromName := s.resolveDisplayName(body.FromHint, fromPGID)
	toName := s.resolveDisplayName(body.ToHint, toPGID)

	msg, needsNudge, err := s.msgSvc.Send(fromPGID, fromName, toPGID, toName, body.Content)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.eventBus.Publish("new_message", msg)
	if conns, err := s.msgSvc.GetConnections(); err == nil {
		s.eventBus.Publish("connections_update", conns)
	}
	if needsNudge {
		s.msgSvc.QueueNudge(toPGID)
	}

	writeJSON(w, map[string]any{
		"message":   msg,
		"to_name":   toName,
		"from_name": fromName,
		"to_id":     toPGID,
		"from_id":   fromPGID,
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
	pgID := s.resolveToPokegentID(r.PathValue("id"))
	msgs, _ := s.msgSvc.GetPending(pgID)
	writeJSON(w, msgs)
}

func (s *Server) handleDeliverPending(w http.ResponseWriter, r *http.Request) {
	pgID := s.resolveToPokegentID(r.PathValue("id"))
	msgs, _ := s.msgSvc.Deliver(pgID)
	writeJSON(w, msgs)
}

func (s *Server) handleConsumePending(w http.ResponseWriter, r *http.Request) {
	pgID := s.resolveToPokegentID(r.PathValue("id"))
	msgs, _ := s.msgSvc.Consume(pgID)
	writeJSON(w, msgs)
}

// resolveSessionID maps any agent ID (pokegent_id, session_id, ccd_session_id, or prefix)
// to the Claude session ID used as the primary map key.
func (s *Server) resolveSessionID(id string) string {
	// Single pass: check all three ID fields per agent
	for _, a := range s.state.GetAgents() {
		for _, candidate := range []string{a.SessionID, a.PokegentID, a.CCDSessionID} {
			if candidate != "" && (candidate == id || strings.HasPrefix(candidate, id)) {
				return a.SessionID
			}
		}
	}
	// Fallback: scan running files (covers stale in-memory state)
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
				PokegentID   string `json:"pokegent_id"`
			}
			if json.Unmarshal(data, &rf) == nil {
				for _, candidate := range []string{rf.PokegentID, rf.CCDSessionID, rf.SessionID} {
					if candidate != "" && (candidate == id || strings.HasPrefix(candidate, id)) {
						return rf.SessionID
					}
				}
			}
		}
	}
	// Last resort: check mailbox directories
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

// resolveToPokegentID maps any agent ID hint (8-char prefix or full UUID) to
// the agent's stable pokegent_id for mailbox routing. pokegent_id is
// backend-agnostic — it survives interface migration and is the only
// identifier the messaging layer should ever use for routing.
//
// Falls back to ccd_session_id then session_id only for legacy running files
// that pre-date the pokegent_id refactor. Returns the input unchanged if no
// agent matches (caller decides what to do).
func (s *Server) resolveToPokegentID(id string) string {
	for _, a := range s.state.GetAgents() {
		for _, candidate := range []string{a.PokegentID, a.CCDSessionID, a.SessionID} {
			if candidate != "" && (candidate == id || strings.HasPrefix(candidate, id)) {
				if a.PokegentID != "" {
					return a.PokegentID
				}
				if a.CCDSessionID != "" {
					return a.CCDSessionID
				}
				return a.SessionID
			}
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

// resolveAgentAndRuntime is the boilerplate every runtime-dispatched handler
// shares: hint → pokegent_id → AgentState → Runtime. Returns (nil, nil, true)
// when an HTTP error has already been written.
func (s *Server) resolveAgentAndRuntime(w http.ResponseWriter, r *http.Request) (*AgentState, Runtime, bool) {
	hint := r.PathValue("id")
	pgid := s.resolveToPokegentID(hint)
	agent := s.state.GetAgent(pgid)
	if agent == nil {
		http.Error(w, "agent not found: "+hint, http.StatusNotFound)
		return nil, nil, true
	}
	rt, err := s.runtimes.For(agent.Interface)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return nil, nil, true
	}
	return agent, rt, false
}

func (s *Server) handleSendPrompt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Prompt string `json:"prompt"`
		Nonce  string `json:"nonce,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.Prompt == "" {
		http.Error(w, "missing prompt", http.StatusBadRequest)
		return
	}
	agent, rt, done := s.resolveAgentAndRuntime(w, r)
	if done {
		return
	}

	// Chat agents: route through the state machine's queue so busy
	// agents enqueue instead of fire-and-forget into a blocked Prompt().
	if agent.Interface == "chat" {
		sess := s.chatMgr.Get(agent.PokegentID)
		if sess != nil {
			queued, err := sess.SubmitPrompt(body.Prompt, body.Nonce)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"ok": true, "queued": queued, "nonce": body.Nonce})
			return
		}
	}

	// Non-chat agents: existing behavior.
	if err := rt.SendPrompt(r.Context(), agent.PokegentID, body.Prompt); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "nonce": body.Nonce})
}

func (s *Server) handleCheckMessages(w http.ResponseWriter, r *http.Request) {
	agent, rt, done := s.resolveAgentAndRuntime(w, r)
	if done {
		return
	}
	if err := rt.CheckMessages(r.Context(), agent.PokegentID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleCancelSession(w http.ResponseWriter, r *http.Request) {
	agent, rt, done := s.resolveAgentAndRuntime(w, r)
	if done {
		return
	}
	if !rt.Capabilities().CanCancel {
		http.Error(w, "runtime does not support cancel", http.StatusBadRequest)
		return
	}


	if err := rt.Cancel(r.Context(), agent.PokegentID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleShutdownSession(w http.ResponseWriter, r *http.Request) {
	agent, rt, done := s.resolveAgentAndRuntime(w, r)
	if done {
		return
	}
	if err := rt.Close(r.Context(), agent.PokegentID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleChatEvents returns events from the in-memory ring buffer for a chat
// session. Supports cursor-based pagination via ?after=<seqNo>. Reconnecting
// clients fetch only the events they missed instead of replaying the full
// SSE stream.
func (s *Server) handleChatEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess := s.chatMgr.Get(id)
	if sess == nil {
		http.Error(w, "chat session not found", http.StatusNotFound)
		return
	}
	var after uint64
	if v := r.URL.Query().Get("after"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			after = n
		}
	}
	events, hasGap := sess.EventsSince(after)
	writeJSON(w, map[string]any{
		"events":  events,
		"has_gap": hasGap,
	})
}

// handleGetQueue returns the pending queued prompts for a chat session.
func (s *Server) handleGetQueue(w http.ResponseWriter, r *http.Request) {
	hint := r.PathValue("id")
	pgid := s.resolveToPokegentID(hint)
	sess := s.chatMgr.Get(pgid)
	if sess == nil {
		// No active chat session — return empty queue.
		writeJSON(w, []QueuedPrompt{})
		return
	}
	if sess.queue == nil {
		writeJSON(w, []QueuedPrompt{})
		return
	}
	writeJSON(w, sess.queue.Pending())
}

func (s *Server) handleDebugForceIdle(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	pgid := s.resolveToPokegentID(id)
	if pgid == "" {
		pgid = id
	}
	s.state.TransitionState(pgid, "idle", "")
	sess := s.chatMgr.Get(pgid)
	if sess != nil {
		sess.BroadcastDone()
	}
	log.Printf("debug[%s]: forced idle", shortChat(pgid))
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleDebugRespawn(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	pgid := s.resolveToPokegentID(id)
	if pgid == "" {
		pgid = id
	}
	runningGlob := filepath.Join(s.dataDir, "running", "*-"+pgid+".json")
	matches, _ := filepath.Glob(runningGlob)
	if len(matches) == 0 {
		http.Error(w, "no running file", http.StatusNotFound)
		return
	}
	raw, err := os.ReadFile(matches[0])
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var rs store.RunningSession
	if err := json.Unmarshal(raw, &rs); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	go func() {
		s.chatMgr.Close(pgid)
		time.Sleep(500 * time.Millisecond)
		if err := s.relaunchChatSession(rs); err != nil {
			log.Printf("debug-respawn[%s]: failed: %v", shortChat(pgid), err)
		} else {
			log.Printf("debug-respawn[%s]: respawned", shortChat(pgid))
		}
	}()
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleListRuntimes(w http.ResponseWriter, _ *http.Request) {
	out := make(map[string]RuntimeCapabilities, len(s.runtimes))
	for name, rt := range s.runtimes {
		out[name] = rt.Capabilities()
	}
	writeJSON(w, out)
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
			if agent.State == "idle" {
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

	iface := agent.Interface
	if iface == "" {
		iface = "iterm2"
	}

	if iface == "chat" {
		// Chat clone: copy the source's JSONL transcript to a new session ID,
		// then launch a new chat agent that loads the copy via session/load.
		// This mirrors what `--fork-session` does for iterm2 agents.

		// 1. Find and copy the JSONL to fork the conversation.
		srcJSONL, err := findJSONLForSession(agent.SessionID)
		if err != nil {
			http.Error(w, "cannot find source transcript: "+err.Error(), http.StatusBadRequest)
			return
		}
		cloneSessionID, err := newPokegentID() // reuse UUID generator for the forked session ID
		if err != nil {
			http.Error(w, "failed to mint clone session id: "+err.Error(), http.StatusInternalServerError)
			return
		}
		dstJSONL := filepath.Join(filepath.Dir(srcJSONL), cloneSessionID+".jsonl")
		if err := copyFile(srcJSONL, dstJSONL); err != nil {
			http.Error(w, "failed to copy transcript: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// 2. Mint identity and pre-write running file.
		pgid, err := newPokegentID()
		if err != nil {
			_ = os.Remove(dstJSONL)
			http.Error(w, "failed to mint pokegent_id: "+err.Error(), http.StatusInternalServerError)
			return
		}

		cloneName := agent.DisplayName
		if cloneName != "" {
			cloneName += " (clone)"
		} else {
			cloneName = "clone"
		}

		rs := store.RunningSession{
			Profile:     profileName,
			PokegentID:  pgid,
			DisplayName: cloneName,
			TaskGroup:   agent.TaskGroup,
			Sprite:      agent.Sprite,
			Model:       agent.Model,
			Effort:      agent.Effort,
			Interface:   "chat",
		}
		runningPath, err := writePlaceholderRunningFile(filepath.Join(s.dataDir, "running"), rs)
		if err != nil {
			_ = os.Remove(dstJSONL)
			http.Error(w, "failed to pre-write running file: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// 3. Launch with session/load pointing at the copied JSONL.
		cwd := agent.CWD
		if cwd == "" {
			if c, err2 := extractCwdFromJSONL(srcJSONL); err2 == nil {
				cwd = c
			} else {
				home, _ := os.UserHomeDir()
				cwd = home
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		if _, err := s.chatMgr.Launch(ctx, ChatLaunchOptions{
			PokegentID:      pgid,
			Profile:         profileName,
			Cwd:             cwd,
			ResumeSessionID: cloneSessionID,
		}); err != nil {
			_ = os.Remove(runningPath)
			_ = os.Remove(dstJSONL)
			http.Error(w, "chat clone failed: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// 4. Persist identity for the clone.
		sprite := agent.Sprite
		if sprite == "" {
			sprite = pickDefaultSprite(pgid)
		}
		id := store.AgentIdentity{
			PokegentID:  pgid,
			DisplayName: cloneName,
			Sprite:      sprite,
			Role:        agent.Role,
			Project:     agent.Project,
			Profile:     profileName,
			TaskGroup:   agent.TaskGroup,
			Model:       agent.Model,
			Effort:      agent.Effort,
			Interface:   "chat",
			CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		}
		if err := s.fileStore.Agents.Save(id); err != nil {
			log.Printf("chat clone: persist identity %s failed: %v", pgid[:8], err)
		}

		s.eventBus.Publish("state_update", s.state.GetAgents())
		writeJSON(w, map[string]any{"ok": true, "pokegent_id": pgid})
		return
	}

	// iterm2: Open a new iTerm2 tab and launch a forked clone via pokegents
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

	// Update iTerm2 Dynamic Profile icon so the tab icon matches immediately
	s.updateITermSprite(sessionID, body.Sprite)

	writeJSON(w, map[string]bool{"ok": true})
}

// updateITermSprite updates the iTerm2 Dynamic Profile icon for a session.
// iTerm2 watches ~/Library/Application Support/iTerm2/DynamicProfiles/ and
// picks up changes automatically.
func (s *Server) updateITermSprite(sessionID, sprite string) {
	home, _ := os.UserHomeDir()
	dynProfileDir := filepath.Join(home, "Library", "Application Support", "iTerm2", "DynamicProfiles")

	// Dynamic Profile is now named by pokegent_id (stable). Try pokegent_id first,
	// then ccd_session_id, then session_id for backward compat.
	agent := s.state.GetAgent(sessionID)
	dynProfile := ""
	for _, candidate := range []string{
		func() string { if agent != nil && agent.PokegentID != "" { return agent.PokegentID }; return "" }(),
		func() string { if agent != nil && agent.CCDSessionID != "" { return agent.CCDSessionID }; return "" }(),
		sessionID,
	} {
		if candidate == "" {
			continue
		}
		p := filepath.Join(dynProfileDir, "pokegents-session-"+candidate+".json")
		if _, err := os.Stat(p); err == nil {
			dynProfile = p
			break
		}
	}
	if dynProfile == "" {
		log.Printf("updateITermSprite: no dynamic profile for %s", sessionID)
		return
	}

	// Read existing profile to preserve Name, Guid, parent
	data, err := os.ReadFile(dynProfile)
	if err != nil {
		return
	}
	var profile map[string]any
	if json.Unmarshal(data, &profile) != nil {
		return
	}

	profiles, ok := profile["Profiles"].([]any)
	if !ok || len(profiles) == 0 {
		return
	}
	p, ok := profiles[0].(map[string]any)
	if !ok {
		return
	}

	// Build absolute path to sprite PNG
	spritePath := filepath.Join(s.webDir, "sprites", sprite+".png")
	if absPath, err := filepath.Abs(spritePath); err == nil {
		spritePath = absPath
	}

	p["Icon"] = 2 // custom icon
	p["Custom Icon Path"] = spritePath
	profiles[0] = p
	profile["Profiles"] = profiles

	updated, err := json.MarshalIndent(profile, "", "  ")
	if err != nil {
		return
	}
	os.WriteFile(dynProfile, updated, 0644)
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
	// Pass --pokegent-id to preserve identity (sprite, grid position, task group, mailbox)
	// across role/project changes
	pokegentID := agent.PokegentID
	if pokegentID == "" {
		pokegentID = agent.CCDSessionID
	}
	cmd := fmt.Sprintf("pokegent %s -r %s", target, sessionID)
	if pokegentID != "" {
		cmd += fmt.Sprintf(" --pokegent-id %s", pokegentID)
	}

	if agent.State == "idle" {
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
