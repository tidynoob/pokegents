// Package services provides higher-level features built on the core engine and store.
package services

import (
	"fmt"
	"log"
	"sync"
	"time"

	"pokegents/dashboard/server/store"
)

// WriteTextFunc is a callback for typing text into an agent's terminal.
// Injected by the server — keeps messaging free of terminal imports.
type WriteTextFunc func(iTermSessionID, tty, text string) error

// AgentLookupFunc returns agent state for nudge decisions.
// Injected by the server — keeps messaging free of state manager imports.
type AgentLookupFunc func(sessionID string) *AgentInfo

// IsSessionFocusedFunc checks if a terminal session is currently focused by the user.
type IsSessionFocusedFunc func(iTermSessionID, tty string) bool

// AgentInfo is the minimal agent state the nudger needs for its guards.
type AgentInfo struct {
	State          string
	IsAlive        bool
	LastUpdated    string
	TTY            string
	ITermSessionID string
}

// MessagingService consolidates message routing, delivery, budget, and nudging.
type MessagingService struct {
	store            store.MessageStore
	writeText        WriteTextFunc
	getAgent         AgentLookupFunc
	isSessionFocused IsSessionFocusedFunc

	// Nudger state
	mu         sync.Mutex
	pending    map[string]*time.Timer // session_id → scheduled nudge
	lastNudge  map[string]time.Time   // session_id → last nudge time
	debounce   time.Duration
	batchDelay time.Duration
	minIdle    time.Duration
}

// NewMessagingService creates a messaging service with injected dependencies.
func NewMessagingService(ms store.MessageStore, writeText WriteTextFunc, getAgent AgentLookupFunc, isFocused IsSessionFocusedFunc) *MessagingService {
	return &MessagingService{
		store:            ms,
		writeText:        writeText,
		getAgent:         getAgent,
		isSessionFocused: isFocused,
		pending:    make(map[string]*time.Timer),
		lastNudge:  make(map[string]time.Time),
		debounce:   10 * time.Second,
		batchDelay: 2 * time.Second,
		minIdle:    3 * time.Second,
	}
}

// Send stores a message and returns whether the recipient should be nudged.
func (s *MessagingService) Send(from, fromName, to, toName, content string) (*store.Message, bool, error) {
	msg, err := s.store.Send(from, fromName, to, toName, content)
	if err != nil {
		return nil, false, err
	}

	// Determine if recipient needs a nudge
	needsNudge := false
	if agent := s.getAgent(to); agent != nil {
		needsNudge = agent.IsAlive && (agent.State == "done" || agent.State == "idle")
	}

	return msg, needsNudge, nil
}

// GetPending returns undelivered messages for a session.
func (s *MessagingService) GetPending(sessionID string) ([]store.Message, error) {
	return s.store.GetUndelivered(sessionID)
}

// Deliver marks undelivered messages as delivered and returns them.
// Called by the hook on UserPromptSubmit for systemMessage injection.
func (s *MessagingService) Deliver(sessionID string) ([]store.Message, error) {
	msgs, err := s.store.GetUndelivered(sessionID)
	if err != nil || len(msgs) == 0 {
		return nil, err
	}
	ids := make([]string, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	if err := s.store.MarkDelivered(ids); err != nil {
		return nil, err
	}
	// Update delivered flag in returned messages
	for i := range msgs {
		msgs[i].Delivered = true
	}
	return msgs, nil
}

// Consume reads all messages and deletes their files.
// Called by the MCP check_messages tool.
func (s *MessagingService) Consume(sessionID string) ([]store.Message, error) {
	return s.store.Consume(sessionID)
}

// GetBudget returns the current message send count for a session.
func (s *MessagingService) GetBudget(sessionID string) (int, error) {
	return s.store.GetBudget(sessionID)
}

// ResetBudget resets the message send count to 0.
func (s *MessagingService) ResetBudget(sessionID string) error {
	return s.store.ResetBudget(sessionID)
}

// GetHistory returns recent message history for UI display.
func (s *MessagingService) GetHistory() ([]store.Message, error) {
	return s.store.GetHistory()
}

// GetConnections returns unique agent pairs that have communicated.
func (s *MessagingService) GetConnections() ([]store.Connection, error) {
	return s.store.GetConnections()
}

// ── Nudger ──────────────────────────────────────────────────────────────

// QueueNudge schedules a "check messages" nudge for an idle/done agent.
// If the agent is busy, no nudge is scheduled (the hook will deliver).
// If already queued, the timer resets (batches rapid messages).
func (s *MessagingService) QueueNudge(sessionID string) {
	agent := s.getAgent(sessionID)
	if agent == nil || !agent.IsAlive {
		return
	}

	if agent.State == "busy" || agent.State == "needs_input" || agent.State == "error" {
		log.Printf("nudger: skip %s — state is %s", sessionID[:8], agent.State)
		return
	}
	log.Printf("nudger: queuing nudge for %s (state=%s)", sessionID[:8], agent.State)

	s.mu.Lock()
	defer s.mu.Unlock()

	if t, ok := s.pending[sessionID]; ok {
		t.Stop()
	}

	s.pending[sessionID] = time.AfterFunc(s.batchDelay, func() {
		s.executeNudge(sessionID)
	})
}

func (s *MessagingService) executeNudge(sessionID string) {
	s.mu.Lock()
	delete(s.pending, sessionID)

	if last, ok := s.lastNudge[sessionID]; ok && time.Since(last) < s.debounce {
		log.Printf("nudger: skip %s — debounced (last nudge %v ago)", sessionID[:8], time.Since(last))
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	agent := s.getAgent(sessionID)
	if agent == nil || !agent.IsAlive {
		log.Printf("nudger: skip %s — agent nil or dead", sessionID[:8])
		return
	}

	if agent.State != "done" && agent.State != "idle" {
		log.Printf("nudger: skip %s — state changed to %s", sessionID[:8], agent.State)
		return
	}

	// Don't nudge if agent just changed state (user might be typing)
	if agent.LastUpdated != "" {
		if t, err := time.Parse(time.RFC3339, agent.LastUpdated); err == nil {
			if time.Since(t) < s.minIdle {
				log.Printf("nudger: defer %s — only idle for %v (need %v)", sessionID[:8], time.Since(t), s.minIdle)
				s.mu.Lock()
				s.pending[sessionID] = time.AfterFunc(s.minIdle, func() {
					s.executeNudge(sessionID)
				})
				s.mu.Unlock()
				return
			}
		}
	}

	if agent.ITermSessionID == "" && agent.TTY == "" {
		log.Printf("nudger: skip %s — no iTerm session or TTY", sessionID[:8])
		return
	}

	// Don't nudge if user is actively typing in this terminal
	if s.isSessionFocused != nil && s.isSessionFocused(agent.ITermSessionID, agent.TTY) {
		log.Printf("nudger: defer %s — session is focused (user may be typing)", sessionID[:8])
		s.mu.Lock()
		s.pending[sessionID] = time.AfterFunc(5*time.Second, func() {
			s.executeNudge(sessionID)
		})
		s.mu.Unlock()
		return
	}

	s.mu.Lock()
	s.lastNudge[sessionID] = time.Now()
	s.mu.Unlock()

	short := sessionID
	if len(short) > 8 {
		short = short[:8]
	}
	itermShort := agent.ITermSessionID
	if len(itermShort) > 8 {
		itermShort = itermShort[:8]
	}
	log.Printf("nudger: NUDGING %s (iTerm=%s, TTY=%s)", short, itermShort, agent.TTY)

	if s.writeText != nil {
		if err := s.writeText(agent.ITermSessionID, agent.TTY, "check messages"); err != nil {
			log.Printf("nudger: terminal error for %s: %v", short, err)
		}
	}
}

// HasPendingNudge returns true if a nudge is scheduled for this session.
func (s *MessagingService) HasPendingNudge(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.pending[sessionID]
	return ok
}

// NudgeIfPending checks if a session has undelivered messages and queues a nudge.
// Called when an agent transitions to done/idle.
func (s *MessagingService) NudgeIfPending(sessionID string) {
	msgs, err := s.store.GetUndelivered(sessionID)
	if err != nil || len(msgs) == 0 {
		return
	}
	s.QueueNudge(sessionID)
}

// FormatMessages returns a display string for a set of messages.
func FormatMessages(msgs []store.Message) string {
	if len(msgs) == 0 {
		return ""
	}
	result := ""
	for i, m := range msgs {
		if i > 0 {
			result += "\n---\n"
		}
		from := m.FromName
		if from == "" {
			from = m.From
		}
		result += fmt.Sprintf("[Message from %s]: %s", from, m.Content)
	}
	return result
}
