package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	storelib "pokegents/dashboard/server/store"
)

// StateManager holds the in-memory merged view of all agent state.
type StateManager struct {
	mu       sync.RWMutex
	store    *storelib.Store          // Layer 0 file-backed store
	profiles map[string]Profile       // keyed by profile name
	running  map[string]RunningSession // keyed by session_id
	statuses map[string]StatusFile     // keyed by session_id
	agents   map[string]*AgentState    // keyed by session_id
	contexts      map[string]ContextUsage   // keyed by session_id, survives rebuilds
	activityFeeds map[string][]ActivityItem // keyed by session_id, survives rebuilds
	nameOverrides map[string]string         // keyed by session_id, persisted to disk
	sessionIDMap  map[string]string         // CCD session ID → Claude session ID, persisted
	agentOrder    []string                  // user-defined display order (session IDs), persisted

	dataDir          string // ~/.ccsession — kept for paths not yet migrated to store
	claudeProjectDir string // ~/.claude/projects
}

func NewStateManager(dataDir, claudeProjectDir string) *StateManager {
	// Legacy constructor — creates its own store
	return NewStateManagerWithStore(storelib.NewFileStore(dataDir), dataDir, claudeProjectDir)
}

func NewStateManagerWithStore(s *storelib.Store, dataDir, claudeProjectDir string) *StateManager {
	return &StateManager{
		store:            s,
		profiles:         make(map[string]Profile),
		running:          make(map[string]RunningSession),
		statuses:         make(map[string]StatusFile),
		agents:           make(map[string]*AgentState),
		contexts:          make(map[string]ContextUsage),
		activityFeeds:     make(map[string][]ActivityItem),
		nameOverrides:    make(map[string]string),
		sessionIDMap:     make(map[string]string),
		dataDir:          dataDir,
		claudeProjectDir: claudeProjectDir,
	}
}

// LoadAll reads all profiles, running sessions, and status files from disk.
func (sm *StateManager) LoadAll() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if err := sm.loadProfiles(); err != nil {
		return err
	}
	if err := sm.loadRunning(); err != nil {
		return err
	}
	if err := sm.loadStatuses(); err != nil {
		return err
	}
	sm.loadNameOverrides()
	sm.loadSessionIDMap()
	sm.loadAgentOrder()
	sm.rebuildAgents()
	sm.reconcileNameOverrides()

	// Load initial context usage for all agents
	for sid := range sm.agents {
		path := sm.findTranscriptPathLocked(sid)
		if path != "" {
			ctx := extractContextUsage(path)
			if ctx.Tokens > 0 {
				sm.contexts[sid] = ctx
				if a, ok := sm.agents[sid]; ok {
					a.ContextTokens = ctx.Tokens
					a.ContextWindow = ctx.Window
				}
			}
		}
	}

	return nil
}

// GetAgents returns only agents that have an active running session registration.
func (sm *StateManager) GetAgents() []AgentState {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	result := make([]AgentState, 0, len(sm.agents))
	for _, a := range sm.agents {
		// Only show agents with a running session file
		if _, hasRunning := sm.running[a.SessionID]; !hasRunning {
			continue
		}
		result = append(result, *a)
	}

	// Sort by user-defined order. Agents in agentOrder come first (in that order),
	// unordered agents go at the end sorted by creation time.
	orderIndex := make(map[string]int, len(sm.agentOrder))
	for i, sid := range sm.agentOrder {
		orderIndex[sid] = i + 1 // 1-based so 0 means "not in list"
	}
	sort.SliceStable(result, func(i, j int) bool {
		oi, oj := orderIndex[result[i].SessionID], orderIndex[result[j].SessionID]
		if oi != 0 && oj != 0 {
			return oi < oj
		}
		if oi != 0 {
			return true // ordered agents before unordered
		}
		if oj != 0 {
			return false
		}
		// Both unordered: sort by creation time
		return result[i].CreatedAt < result[j].CreatedAt
	})

	return result
}

// GetAgent returns a single agent by session ID or CCD session ID.
func (sm *StateManager) GetAgent(sessionID string) *AgentState {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if a, ok := sm.agents[sessionID]; ok {
		cp := *a
		return &cp
	}
	// Also check by CCD session ID
	for _, a := range sm.agents {
		if a.CCDSessionID != "" && a.CCDSessionID == sessionID {
			cp := *a
			return &cp
		}
	}
	return nil
}

// RenameAgent updates the display name in the running file, name overrides, and in-memory state.
func (sm *StateManager) RenameAgent(sessionID, newName string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Update in-memory
	if a, ok := sm.agents[sessionID]; ok {
		a.DisplayName = newName
	}

	// Update running file on disk via store
	if rs, ok := sm.running[sessionID]; ok {
		rs.DisplayName = newName
		sm.running[sessionID] = rs
		sm.store.Running.Update(sessionID, func(r *RunningSession) {
			r.DisplayName = newName
		})
	}

	// JSONL custom-title is written by server.go persistCustomTitle() which
	// also updates the search index. Don't duplicate the write here.

	// Store name override under session ID
	sm.nameOverrides[sessionID] = newName

	// For clones: also store under CCDSessionID if different, so the
	// override survives even if the search index uses a different ID
	if rs, ok := sm.running[sessionID]; ok && rs.CCDSessionID != "" && rs.CCDSessionID != sessionID {
		sm.nameOverrides[rs.CCDSessionID] = newName
	}
	sm.saveNameOverrides()
}

// TransitionDoneToIdle transitions agents that have been "done" for more than
// 10 minutes to "idle" state. Returns true if any agent was transitioned.
func (sm *StateManager) TransitionDoneToIdle() bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	changed := false
	for _, a := range sm.agents {
		if a.State != "done" {
			continue
		}
		if a.LastUpdated == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339, a.LastUpdated)
		if err != nil {
			continue
		}
		if time.Since(t) > 10*time.Minute {
			a.State = "idle"
			a.LastUpdated = time.Now().UTC().Format(time.RFC3339)
			// Also update the status file on disk via store
			if sf, ok := sm.statuses[a.SessionID]; ok {
				sf.State = "idle"
				sf.Timestamp = a.LastUpdated
				sm.statuses[a.SessionID] = sf
				sm.store.Status.Upsert(sf)
			}
			changed = true
		}
	}
	return changed
}

// CleanStale removes running files for dead sessions and rebuilds state. Returns true if anything changed.
func (sm *StateManager) CleanStale() bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	changed := false
	runningDir := filepath.Join(sm.dataDir, "running")
	for sid, rs := range sm.running {
		alive := false

		// Check 0: Grace period — don't kill files less than 30s old (hook hasn't patched yet)
		pattern := filepath.Join(runningDir, "*-"+sid+".json")
		matches, _ := filepath.Glob(pattern)
		if len(matches) > 0 {
			if info, err := os.Stat(matches[0]); err == nil {
				if time.Since(info.ModTime()) < 30*time.Second {
					continue // too new to judge
				}
			}
		}

		// Check 1: Claude's PID (most reliable)
		if rs.ClaudePID > 0 && isProcessAlive(rs.ClaudePID) {
			alive = true
		}

		// Check 2: Shell PID (legacy)
		if !alive && rs.PID > 0 && isProcessAlive(rs.PID) {
			alive = true
		}

		// Check 3: Claude session registry (authoritative fallback)
		if !alive {
			alive = sm.isClaudeSessionAlive(sid)
		}

		if !alive {
			pattern := filepath.Join(runningDir, "*-"+sid+".json")
			matches, _ := filepath.Glob(pattern)
			for _, f := range matches {
				os.Remove(f)
			}
			delete(sm.running, sid)
			changed = true
		}
	}
	if changed {
		sm.rebuildAgents()
	}
	return changed
}

// isClaudeSessionAlive checks if there's a live Claude process on the TTY
// associated with this running session.
func (sm *StateManager) isClaudeSessionAlive(sessionID string) bool {
	rs, ok := sm.running[sessionID]
	if !ok || rs.TTY == "" {
		return false
	}
	// Check if any Claude process is on this TTY
	sessionsDir := filepath.Join(filepath.Dir(sm.claudeProjectDir), "sessions")
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(sessionsDir, e.Name()))
		if err != nil {
			continue
		}
		var sess struct {
			PID int `json:"pid"`
		}
		if json.Unmarshal(data, &sess) != nil || !isProcessAlive(sess.PID) {
			continue
		}
		out, _ := exec.Command("ps", "-p", fmt.Sprintf("%d", sess.PID), "-o", "tty=").Output()
		tty := "/dev/" + strings.TrimSpace(string(out))
		if tty == rs.TTY {
			return true
		}
	}
	return false
}

// ReconcileRunningFiles checks Claude's session registry for running files that have
// mismatched session IDs and patches them. Returns true if anything changed.
func (sm *StateManager) ReconcileRunningFiles() bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	changed := false
	sessionsDir := filepath.Join(filepath.Dir(sm.claudeProjectDir), "sessions")
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return false
	}

	// Build map of TTY → Claude PID from session registry
	// NOTE: we only backfill claude_pid here, NOT session_id.
	// The session ID in ~/.claude/sessions/ is a process ID, not the conversation ID.
	ttyToPID := make(map[string]int)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(sessionsDir, e.Name()))
		if err != nil {
			continue
		}
		var sess struct {
			PID int `json:"pid"`
		}
		if json.Unmarshal(data, &sess) != nil || !isProcessAlive(sess.PID) {
			continue
		}
		out, err := exec.Command("ps", "-p", fmt.Sprintf("%d", sess.PID), "-o", "tty=").Output()
		if err == nil {
			tty := "/dev/" + strings.TrimSpace(string(out))
			if tty != "/dev/" {
				ttyToPID[tty] = sess.PID
			}
		}
	}

	for sid, rs := range sm.running {
		if rs.ClaudePID > 0 {
			continue
		}
		if pid, ok := ttyToPID[rs.TTY]; ok {
			if err := sm.store.Running.Update(sid, func(r *RunningSession) {
				r.ClaudePID = pid
			}); err == nil {
				changed = true
			}
		}
	}

	if changed {
		sm.loadRunning()
		sm.rebuildAgents()
	}
	return changed
}

// UpdateUserPrompt sets the user prompt for a session.
func (sm *StateManager) UpdateUserPrompt(sessionID, prompt string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sf, ok := sm.statuses[sessionID]; ok {
		sf.UserPrompt = prompt
		sm.statuses[sessionID] = sf
	}
	if a, ok := sm.agents[sessionID]; ok {
		a.UserPrompt = prompt
	}
}

// UpdateContext updates token usage for a session.
func (sm *StateManager) UpdateContext(sessionID string, tokens, window int) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.contexts[sessionID] = ContextUsage{Tokens: tokens, Window: window}
	if a, ok := sm.agents[sessionID]; ok {
		a.ContextTokens = tokens
		a.ContextWindow = window
	}
}

// UpdateSummary updates the last summary for a session.
func (sm *StateManager) UpdateSummary(sessionID, summary string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sf, ok := sm.statuses[sessionID]; ok {
		sf.LastSummary = summary
		sm.statuses[sessionID] = sf
	}
	if a, ok := sm.agents[sessionID]; ok {
		a.LastSummary = summary
	}
}

// UpdateTrace updates just the trace for a session.
func (sm *StateManager) UpdateTrace(sessionID, trace string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sf, ok := sm.statuses[sessionID]; ok {
		sf.LastTrace = trace
		sm.statuses[sessionID] = sf
	}
	if a, ok := sm.agents[sessionID]; ok {
		a.LastTrace = trace
	}
}

// UpdateActivityFeed merges transcript-extracted text/thinking items into the
// hook-built activity feed. Hooks provide real-time tool calls; the poller
// provides text/thinking blocks that appear between tools in the transcript.
func (sm *StateManager) UpdateActivityFeed(sessionID string, transcriptFeed []ActivityItem) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	existing := sm.activityFeeds[sessionID]

	// If no existing feed, use the transcript feed directly
	if len(existing) == 0 {
		sm.activityFeeds[sessionID] = transcriptFeed
		if a, ok := sm.agents[sessionID]; ok {
			a.ActivityFeed = transcriptFeed
		}
		return
	}

	// Only ADD text/thinking items from the transcript that aren't already
	// in the feed. Hook events are the primary source for tool calls (immediate),
	// and the transcript supplements with text/thinking between tools.
	// Never replace or reorder existing items.
	existingTexts := make(map[string]bool)
	for _, item := range existing {
		if item.Type == "text" || item.Type == "thinking" {
			existingTexts[item.Text] = true
		}
	}

	added := false
	for _, item := range transcriptFeed {
		if item.Type == "text" || item.Type == "thinking" {
			if !existingTexts[item.Text] {
				existing = append(existing, item)
				existingTexts[item.Text] = true
				added = true
			}
		}
	}

	if added {
		if len(existing) > 20 {
			existing = existing[len(existing)-20:]
		}
		sm.activityFeeds[sessionID] = existing
		if a, ok := sm.agents[sessionID]; ok {
			a.ActivityFeed = existing
		}
	}
}

// FindTranscriptPath locates the transcript JSONL for a session. Thread-safe.
func (sm *StateManager) FindTranscriptPath(sessionID string) string {
	return sm.findTranscriptPathLocked(sessionID)
}

func (sm *StateManager) findTranscriptPathLocked(sessionID string) string {
	entries, err := os.ReadDir(sm.claudeProjectDir)
	if err != nil {
		return ""
	}
	for _, d := range entries {
		if !d.IsDir() {
			continue
		}
		path := filepath.Join(sm.claudeProjectDir, d.Name(), sessionID+".jsonl")
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

// GetProfiles returns all loaded profiles.
// GetNameOverrides returns a copy of the name overrides map.
func (sm *StateManager) GetNameOverrides() map[string]string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	m := make(map[string]string, len(sm.nameOverrides))
	for k, v := range sm.nameOverrides {
		m[k] = v
	}
	return m
}

// GetSessionIDMap returns a copy of the CCD→Claude session ID map.
func (sm *StateManager) GetSessionIDMap() map[string]string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	m := make(map[string]string, len(sm.sessionIDMap))
	for k, v := range sm.sessionIDMap {
		m[k] = v
	}
	return m
}

// GetProfile returns a single profile by name.
func (sm *StateManager) GetProfile(name string) *Profile {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if p, ok := sm.profiles[name]; ok {
		return &p
	}
	return nil
}

func (sm *StateManager) GetProfiles() []Profile {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	result := make([]Profile, 0, len(sm.profiles))
	for _, p := range sm.profiles {
		result = append(result, p)
	}
	return result
}

// ReloadRunning reloads running session files and rebuilds agents.
func (sm *StateManager) ReloadRunning() {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.loadRunning()
	sm.rebuildAgents()
}

// ReloadStatus reloads a single status file and rebuilds agents.
func (sm *StateManager) ReloadStatus(path string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	base := strings.TrimSuffix(filepath.Base(path), ".json")
	sf, err := sm.store.Status.Get(base)
	if err != nil || sf == nil {
		// File was deleted or unreadable — remove from statuses
		delete(sm.statuses, base)
	} else {
		sm.statuses[sf.SessionID] = *sf
	}
	sm.rebuildAgents()
}

// UpdateFromEvent processes an incoming hook event.
func (sm *StateManager) UpdateFromEvent(evt HookEvent) *AgentState {
	if evt.SessionID == "" {
		return nil
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Update status from event (mirrors status-update.sh logic)
	sf, exists := sm.statuses[evt.SessionID]
	if !exists {
		sf = StatusFile{SessionID: evt.SessionID}
	}

	// Guard against race conditions: a slow PreToolUse/PostToolUse arriving after
	// Stop should not overwrite "done" with "busy". Only UserPromptSubmit can
	// transition out of done/error/idle.
	if exists && sf.State != "busy" && sf.State != "needs_input" && sf.State != "" {
		switch evt.HookEventName {
		case "PreToolUse", "PostToolUse", "PostToolUseFailure":
			return nil
		}
	}

	sf.CWD = evt.CWD
	sf.Timestamp = time.Now().UTC().Format(time.RFC3339)

	switch evt.HookEventName {
	case "UserPromptSubmit":
		sf.State = "busy"
		sf.Detail = "processing prompt"
		sf.BusySince = time.Now().UTC().Format(time.RFC3339)
		sf.LastSummary = ""
		sf.LastTrace = ""
		sf.RecentActions = nil
		if evt.Prompt != "" {
			sf.UserPrompt = truncate(evt.Prompt, 200)
		}
	case "PreToolUse":
		sf.State = "busy"
		toolInput := ""
		if m, ok := evt.ToolInput.(map[string]any); ok {
			for _, key := range []string{"command", "file_path", "pattern", "query", "description"} {
				if v, ok := m[key]; ok {
					toolInput = truncate(toString(v), 80)
					break
				}
			}
		}
		sf.Detail = evt.ToolName + ": " + toolInput
		sf.RecentActions = appendAction(sf.RecentActions, evt.ToolName+": "+toolInput)
		sf.LastTrace = extractTraceFromTranscript(evt.TranscriptPath)
	case "PostToolUse":
		sf.State = "busy"
		sf.Detail = "completed " + evt.ToolName
		sf.LastTrace = extractTraceFromTranscript(evt.TranscriptPath)
	case "PostToolUseFailure":
		sf.State = "busy"
		sf.Detail = evt.ToolName + " failed"
		sf.RecentActions = appendAction(sf.RecentActions, evt.ToolName+" failed")
		sf.LastTrace = extractTraceFromTranscript(evt.TranscriptPath)
	case "StopFailure":
		sf.State = "error"
		sf.Detail = "API error — reprompt to retry"
		sf.RecentActions = nil
		sf.BusySince = ""
	case "Stop":
		sf.State = "done"
		sf.Detail = "finished"
		sf.RecentActions = nil
		sf.BusySince = ""
		sf.LastSummary = truncate(evt.LastAssistantMessage, 200)
	case "PermissionRequest":
		sf.State = "needs_input"
		sf.Detail = "needs permission for " + evt.ToolName
	case "Notification":
		if evt.NotificationType == "idle_prompt" {
			// idle_prompt only transitions busy → done (never sets needs_input;
			// that's exclusively for PermissionRequest)
			if sf.State == "busy" {
				sf.State = "done"
				sf.Detail = "finished"
				sf.BusySince = ""
				if evt.TranscriptPath != "" {
					trace := extractTraceFromTranscript(evt.TranscriptPath)
					if trace != "" {
						sf.LastSummary = trace
					}
				}
			}
		}
	case "SessionStart":
		sf.State = "idle"
		sf.Detail = "session started"
	case "SessionEnd":
		// Remove from statuses — agent disappears from dashboard
		delete(sm.statuses, evt.SessionID)
		sm.rebuildAgents()
		return nil
	default:
		return nil
	}

	sm.statuses[evt.SessionID] = sf

	// Update context from transcript if available
	if evt.TranscriptPath != "" {
		ctx := extractContextUsage(evt.TranscriptPath)
		if ctx.Tokens > 0 {
			sm.contexts[evt.SessionID] = ctx
		}
	}

	sm.rebuildAgents()

	// Append tool calls to activity feed for immediate display
	{
		ts := time.Now().Local().Format("15:04:05")
		feed := sm.activityFeeds[evt.SessionID]
		switch evt.HookEventName {
		case "UserPromptSubmit":
			feed = nil
		case "PreToolUse":
			toolInput := ""
			if m, ok := evt.ToolInput.(map[string]any); ok {
				for _, key := range []string{"command", "file_path", "pattern", "query", "description"} {
					if v, ok := m[key]; ok {
						toolInput = truncate(toString(v), 80)
						break
					}
				}
			}
			feed = append(feed, ActivityItem{Time: ts, Type: "tool", Text: evt.ToolName + ": " + toolInput})
			if len(feed) > 20 {
				feed = feed[len(feed)-20:]
			}
		case "PostToolUseFailure":
			feed = append(feed, ActivityItem{Time: ts, Type: "tool", Text: evt.ToolName + " failed"})
			if len(feed) > 20 {
				feed = feed[len(feed)-20:]
			}
		}
		sm.activityFeeds[evt.SessionID] = feed
		if a, ok := sm.agents[evt.SessionID]; ok {
			a.ActivityFeed = feed
		}
	}

	if a, ok := sm.agents[evt.SessionID]; ok {
		cp := *a
		return &cp
	}
	return nil
}

// --- internal helpers ---

func (sm *StateManager) loadProfiles() error {
	profiles, err := sm.store.Profiles.List()
	if err != nil {
		return nil
	}
	sm.profiles = make(map[string]Profile, len(profiles))
	for _, p := range profiles {
		sm.profiles[p.Name] = p
	}
	return nil
}

func (sm *StateManager) loadRunning() error {
	sessions, err := sm.store.Running.List()
	if err != nil {
		return nil
	}
	sm.running = make(map[string]RunningSession, len(sessions))
	for _, rs := range sessions {
		if rs.SessionID != "" {
			sm.running[rs.SessionID] = rs
		}
	}
	return nil
}

func (sm *StateManager) loadStatuses() error {
	statuses, err := sm.store.Status.List()
	if err != nil {
		return nil
	}
	sm.statuses = make(map[string]StatusFile, len(statuses))
	for _, sf := range statuses {
		if sf.SessionID != "" {
			sm.statuses[sf.SessionID] = sf
		}
	}
	return nil
}

func (sm *StateManager) loadNameOverrides() {
	sm.store.Metadata.LoadJSON("name-overrides.json", &sm.nameOverrides)
}

func (sm *StateManager) saveNameOverrides() {
	sm.store.Metadata.SaveJSON("name-overrides.json", sm.nameOverrides)
}

func (sm *StateManager) loadSessionIDMap() {
	sm.store.Metadata.LoadJSON("session-id-map.json", &sm.sessionIDMap)
}

func (sm *StateManager) saveSessionIDMap() {
	sm.store.Metadata.SaveJSON("session-id-map.json", sm.sessionIDMap)
}

func (sm *StateManager) loadAgentOrder() {
	sm.store.Metadata.LoadJSON("agent-order.json", &sm.agentOrder)
}

func (sm *StateManager) saveAgentOrder() {
	sm.store.Metadata.SaveJSON("agent-order.json", sm.agentOrder)
}

// GetAgentOrder returns the current agent display order.
func (sm *StateManager) GetAgentOrder() []string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	result := make([]string, len(sm.agentOrder))
	copy(result, sm.agentOrder)
	return result
}

// SetAgentOrder saves a new agent display order.
func (sm *StateManager) SetAgentOrder(order []string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.agentOrder = order
	sm.saveAgentOrder()
}

// reconcileNameOverrides uses the session ID map to fix name-override entries
// keyed by CCD session IDs (which have no JSONL transcript). Maps them to
// the Claude conversation session ID so the search index can find them.
func (sm *StateManager) reconcileNameOverrides() {
	changed := false
	for ccdSID, name := range sm.nameOverrides {
		if sm.findTranscriptPathLocked(ccdSID) != "" {
			continue // has transcript, all good
		}
		// Check if session ID map has a mapping for this CCD UUID
		if claudeSID, ok := sm.sessionIDMap[ccdSID]; ok {
			if sm.findTranscriptPathLocked(claudeSID) != "" {
				sm.nameOverrides[claudeSID] = name
				delete(sm.nameOverrides, ccdSID)
				changed = true
				log.Printf("state: reconciled name override %s → %s (%s)", ccdSID[:8], claudeSID[:8], name)
			}
		}
	}
	if changed {
		sm.saveNameOverrides()
	}
}

func (sm *StateManager) rebuildAgents() {
	now := time.Now()
	agents := make(map[string]*AgentState)

	// Build session ID map from running files (CCD UUID → Claude session ID)
	mapChanged := false
	for sid, rs := range sm.running {
		if rs.CCDSessionID != "" && rs.CCDSessionID != sid {
			if sm.sessionIDMap[rs.CCDSessionID] != sid {
				sm.sessionIDMap[rs.CCDSessionID] = sid
				mapChanged = true
			}
		}
	}
	if mapChanged {
		sm.saveSessionIDMap()
	}

	// Start with running sessions as the base
	for sid, rs := range sm.running {
		a := &AgentState{
			SessionID:      sid,
			CCDSessionID:   rs.CCDSessionID,
			ProfileName:    rs.Profile,
			DisplayName:    rs.DisplayName,
			PID:            rs.PID,
			TTY:            rs.TTY,
			ITermSessionID: rs.ITermSessionID,
			State:          "idle",
		}

		// Enrich from profile
		if p, ok := sm.profiles[rs.Profile]; ok {
			a.Emoji = p.Emoji
			a.Color = p.Color
			if a.DisplayName == "" {
				a.DisplayName = p.Title
			}
		}

		// Apply persistent name override (survives session restarts)
		if override, ok := sm.nameOverrides[sid]; ok {
			a.DisplayName = override
		} else if rs.CCDSessionID != "" {
			if override, ok := sm.nameOverrides[rs.CCDSessionID]; ok {
				a.DisplayName = override
			}
		}

		// Check PID liveness
		a.IsAlive = isProcessAlive(rs.PID)

		// Get creation time from running file field, fall back to mtime
		if rs.CreatedAt != "" {
			a.CreatedAt = rs.CreatedAt
		} else {
			runningDir := filepath.Join(sm.dataDir, "running")
			pattern := filepath.Join(runningDir, "*-"+sid+".json")
			if matches, _ := filepath.Glob(pattern); len(matches) > 0 {
				if info, err := os.Stat(matches[0]); err == nil {
					a.CreatedAt = info.ModTime().UTC().Format(time.RFC3339)
				}
			}
		}

		agents[sid] = a
	}

	// Merge status data
	for sid, sf := range sm.statuses {
		a, exists := agents[sid]
		if !exists {
			a = &AgentState{
				SessionID: sid,
			}
			// Try to match profile by CWD
			a.ProfileName, a.Emoji, a.Color = sm.matchProfileLocked(sf.CWD)
			agents[sid] = a
		}
		a.State = sf.State
		a.Detail = sf.Detail
		a.CWD = sf.CWD
		a.LastSummary = sf.LastSummary
		a.LastTrace = sf.LastTrace
		a.RecentActions = sf.RecentActions
		a.UserPrompt = sf.UserPrompt
		a.LastUpdated = sf.Timestamp
		a.BusySince = sf.BusySince

		// Compute duration
		if t, err := time.Parse(time.RFC3339, sf.Timestamp); err == nil {
			a.DurationSec = int(now.Sub(t).Seconds())
		}
	}

	// Re-apply persisted context usage
	for sid, ctx := range sm.contexts {
		if a, ok := agents[sid]; ok {
			a.ContextTokens = ctx.Tokens
			a.ContextWindow = ctx.Window
		}
	}

	// Re-apply persisted activity feeds
	for sid, feed := range sm.activityFeeds {
		if a, ok := agents[sid]; ok {
			a.ActivityFeed = feed
		}
	}

	sm.agents = agents
}

// MatchProfile finds the best matching profile for a given cwd. Thread-safe.
func (sm *StateManager) MatchProfile(cwd string) (name, emoji string, color [3]int) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.matchProfileLocked(cwd)
}

func (sm *StateManager) matchProfileLocked(cwd string) (name, emoji string, color [3]int) {
	if cwd == "" {
		return "", "", [3]int{}
	}
	bestLen := 0
	for _, p := range sm.profiles {
		if strings.HasPrefix(cwd, p.CWD) && len(p.CWD) > bestLen {
			name = p.Name
			emoji = p.Emoji
			color = p.Color
			bestLen = len(p.CWD)
		}
	}
	return
}

func appendAction(actions []string, action string) []string {
	actions = append(actions, action)
	if len(actions) > 6 {
		actions = actions[len(actions)-6:]
	}
	return actions
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil
}

func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen])
}

func toString(v any) string {
	switch val := v.(type) {
	case string:
		return val
	default:
		b, _ := json.Marshal(val)
		return string(b)
	}
}

// ContextUsage holds token counts extracted from a transcript.
type ContextUsage struct {
	Tokens int
	Window int
}

// extractContextUsage reads the last assistant message's usage from the transcript.
func extractContextUsage(path string) ContextUsage {
	if path == "" {
		return ContextUsage{}
	}
	f, err := os.Open(path)
	if err != nil {
		return ContextUsage{}
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return ContextUsage{}
	}
	offset := info.Size() - 256*1024
	if offset < 0 {
		offset = 0
	}
	f.Seek(offset, 0)

	data, err := io.ReadAll(f)
	if err != nil {
		return ContextUsage{}
	}

	var lastTokens int
	var model string
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry["type"] != "assistant" {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		if m, ok := msg["model"].(string); ok && m != "" {
			model = m
		}
		usage, ok := msg["usage"].(map[string]any)
		if !ok {
			continue
		}
		total := 0
		if v, ok := usage["input_tokens"].(float64); ok {
			total += int(v)
		}
		if v, ok := usage["cache_creation_input_tokens"].(float64); ok {
			total += int(v)
		}
		if v, ok := usage["cache_read_input_tokens"].(float64); ok {
			total += int(v)
		}
		if total > 100 { // Filter out dummy/placeholder usage (forked sessions have input_tokens=1)
			lastTokens = total
		}
	}

	window := 200000 // default
	if strings.Contains(model, "opus") {
		window = 1000000
	} else if strings.Contains(model, "sonnet") {
		window = 200000
	} else if strings.Contains(model, "haiku") {
		window = 200000
	}

	return ContextUsage{Tokens: lastTokens, Window: window}
}

// extractTraceFromTranscript reads the tail of a transcript JSONL and returns
// the last assistant text block (the live thinking/output trace).
func extractTraceFromTranscript(path string) string {
	if path == "" {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	// Read last 32KB of the file to find the last assistant message
	info, err := f.Stat()
	if err != nil {
		return ""
	}
	offset := info.Size() - 256*1024
	if offset < 0 {
		offset = 0
	}
	f.Seek(offset, 0)

	data, err := io.ReadAll(f)
	if err != nil {
		return ""
	}

	lastText := ""
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry["type"] != "assistant" {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		content, ok := msg["content"].([]any)
		if !ok {
			continue
		}
		for _, block := range content {
			m, ok := block.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "text" {
				if t, ok := m["text"].(string); ok && t != "" {
					lastText = t
				}
			}
		}
	}

	if len(lastText) > 200 {
		lastText = lastText[len(lastText)-200:]
	}
	return lastText
}

// extractActivityFeed reads the transcript and builds a unified timeline of
// tool calls and text/thinking output from the last user turn.
func extractActivityFeed(path string) []ActivityItem {
	if path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	// Read last 64KB
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	offset := info.Size() - 256*1024
	if offset < 0 {
		offset = 0
	}
	f.Seek(offset, 0)
	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}

	// Find the last user message, then collect all assistant content after it
	type rawEntry struct {
		Type    string `json:"type"`
		Message struct {
			Content []json.RawMessage `json:"content"`
		} `json:"message"`
		Timestamp string `json:"timestamp"`
	}

	var entries []rawEntry
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var e rawEntry
		if json.Unmarshal([]byte(line), &e) == nil {
			entries = append(entries, e)
		}
	}

	// Find last user message index
	lastUserIdx := -1
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Type == "user" {
			lastUserIdx = i
			break
		}
	}

	var feed []ActivityItem
	startIdx := lastUserIdx + 1
	if startIdx < 0 {
		startIdx = 0
	}

	for _, e := range entries[startIdx:] {
		if e.Type != "assistant" {
			continue
		}
		ts := ""
		if e.Timestamp != "" {
			if t, err := time.Parse(time.RFC3339Nano, e.Timestamp); err == nil {
				ts = t.Local().Format("15:04:05")
			} else if t, err := time.Parse(time.RFC3339, e.Timestamp); err == nil {
				ts = t.Local().Format("15:04:05")
			}
		}

		for _, raw := range e.Message.Content {
			var block map[string]any
			if json.Unmarshal(raw, &block) != nil {
				continue
			}
			btype, _ := block["type"].(string)
			switch btype {
			case "thinking":
				if t, ok := block["thinking"].(string); ok && t != "" {
					text := t
					if len(text) > 150 {
						text = text[len(text)-150:]
					}
					feed = append(feed, ActivityItem{Time: ts, Type: "thinking", Text: text})
				}
			case "text":
				if t, ok := block["text"].(string); ok && t != "" {
					text := t
					if len(text) > 150 {
						text = text[len(text)-150:]
					}
					feed = append(feed, ActivityItem{Time: ts, Type: "text", Text: text})
				}
			case "tool_use":
				name, _ := block["name"].(string)
				input := ""
				if m, ok := block["input"].(map[string]any); ok {
					for _, key := range []string{"command", "file_path", "pattern", "query", "description", "prompt"} {
						if v, ok := m[key]; ok {
							input = truncate(fmt.Sprintf("%v", v), 80)
							break
						}
					}
				}
				feed = append(feed, ActivityItem{Time: ts, Type: "tool", Text: name + ": " + input})
			}
		}
	}

	// Keep last 12 items
	if len(feed) > 20 {
		feed = feed[len(feed)-20:]
	}
	return feed
}

// extractLastUserPrompt reads the transcript and returns the last user message.
func extractLastUserPrompt(path string) string {
	if path == "" {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return ""
	}
	offset := info.Size() - 256*1024
	if offset < 0 {
		offset = 0
	}
	f.Seek(offset, 0)

	data, err := io.ReadAll(f)
	if err != nil {
		return ""
	}

	lastPrompt := ""
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry["type"] != "user" {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		content := msg["content"]
		switch c := content.(type) {
		case string:
			if c != "" {
				lastPrompt = c
			}
		case []any:
			for _, block := range c {
				if m, ok := block.(map[string]any); ok {
					if t, ok := m["text"].(string); ok && t != "" {
						lastPrompt = t
					}
				}
			}
		}
	}

	r := []rune(lastPrompt)
	if len(r) > 200 {
		return string(r[:200])
	}
	return lastPrompt
}

// extractLastAssistantMessage reads the tail of a transcript and returns the
// last assistant text block, truncated to 200 chars from the start. Used to
// backfill LastSummary on cold start when hooks haven't fired yet.
func extractLastAssistantMessage(path string) string {
	if path == "" {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return ""
	}
	offset := info.Size() - 256*1024
	if offset < 0 {
		offset = 0
	}
	f.Seek(offset, 0)

	data, err := io.ReadAll(f)
	if err != nil {
		return ""
	}

	lastText := ""
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry["type"] != "assistant" {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		content, ok := msg["content"].([]any)
		if !ok {
			continue
		}
		for _, block := range content {
			m, ok := block.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "text" {
				if t, ok := m["text"].(string); ok && t != "" {
					lastText = t
				}
			}
		}
	}

	r := []rune(lastText)
	if len(r) > 200 {
		return string(r[:200])
	}
	return lastText
}
