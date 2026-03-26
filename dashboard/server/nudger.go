package server

import (
	"log"
	"sync"
	"time"
)

// Nudger queues and delivers "check messages" nudges to idle agents.
// It never interrupts busy agents or erases user-typed text.
//
// Flow:
//   - Message sent to agent → Nudger.Queue(sessionID)
//   - If agent is busy: do nothing (hook delivers on Stop/UserPromptSubmit)
//   - If agent is done/idle: schedule a nudge after a short delay
//   - When delay fires: re-check state. Only nudge if still done/idle
//     AND the agent has been in that state for at least 3 seconds
//   - Debounce: don't re-nudge same agent within 10 seconds
type Nudger struct {
	mu         sync.Mutex
	state      *StateManager
	terminal   TerminalIntegration
	pending    map[string]*time.Timer // session_id → scheduled nudge
	lastNudge  map[string]time.Time   // session_id → last nudge time
	debounce   time.Duration
	batchDelay time.Duration
	minIdle    time.Duration // minimum idle time before nudging
}

func NewNudger(state *StateManager, terminal TerminalIntegration) *Nudger {
	return &Nudger{
		state:      state,
		terminal:   terminal,
		pending:    make(map[string]*time.Timer),
		lastNudge:  make(map[string]time.Time),
		debounce:   10 * time.Second,
		batchDelay: 2 * time.Second,
		minIdle:    3 * time.Second,
	}
}

// Queue schedules a nudge for the given agent. If the agent is busy,
// no nudge is scheduled (the hook will deliver on Stop). If already
// queued, the timer is reset (batches rapid messages).
func (n *Nudger) Queue(sessionID string) {
	agent := n.state.GetAgent(sessionID)
	if agent == nil || !agent.IsAlive {
		return
	}

	// Don't nudge busy agents — hook delivers via systemMessage on Stop
	if agent.State == "busy" || agent.State == "needs_input" || agent.State == "error" {
		log.Printf("nudger: skip %s — state is %s", sessionID[:8], agent.State)
		return
	}
	log.Printf("nudger: queuing nudge for %s (state=%s)", sessionID[:8], agent.State)

	n.mu.Lock()
	defer n.mu.Unlock()

	// Cancel existing timer (resets batch window)
	if t, ok := n.pending[sessionID]; ok {
		t.Stop()
	}

	n.pending[sessionID] = time.AfterFunc(n.batchDelay, func() {
		n.execute(sessionID)
	})
}

func (n *Nudger) execute(sessionID string) {
	n.mu.Lock()
	delete(n.pending, sessionID)

	// Debounce check
	if last, ok := n.lastNudge[sessionID]; ok && time.Since(last) < n.debounce {
		log.Printf("nudger: skip %s — debounced (last nudge %v ago)", sessionID[:8], time.Since(last))
		n.mu.Unlock()
		return
	}
	n.mu.Unlock()

	// Re-check agent state (may have changed during delay)
	agent := n.state.GetAgent(sessionID)
	if agent == nil || !agent.IsAlive {
		log.Printf("nudger: skip %s — agent nil or dead", sessionID[:8])
		return
	}

	// Only nudge done/idle agents
	if agent.State != "done" && agent.State != "idle" {
		log.Printf("nudger: skip %s — state changed to %s", sessionID[:8], agent.State)
		return
	}

	// Don't nudge if agent just changed state (user might be typing)
	if agent.LastUpdated != "" {
		if t, err := time.Parse(time.RFC3339, agent.LastUpdated); err == nil {
			if time.Since(t) < n.minIdle {
				log.Printf("nudger: defer %s — only idle for %v (need %v)", sessionID[:8], time.Since(t), n.minIdle)
				n.mu.Lock()
				n.pending[sessionID] = time.AfterFunc(n.minIdle, func() {
					n.execute(sessionID)
				})
				n.mu.Unlock()
				return
			}
		}
	}

	// No iTerm session or TTY — can't nudge
	if agent.ITermSessionID == "" && agent.TTY == "" {
		log.Printf("nudger: skip %s — no iTerm session or TTY", sessionID[:8])
		return
	}

	// Record nudge time
	n.mu.Lock()
	n.lastNudge[sessionID] = time.Now()
	n.mu.Unlock()

	itermShort := agent.ITermSessionID
	if len(itermShort) > 8 {
		itermShort = itermShort[:8]
	}
	log.Printf("nudger: NUDGING %s (iTerm=%s, TTY=%s)", sessionID[:8], itermShort, agent.TTY)

	// Type "check messages" into the agent's terminal
	if err := n.terminal.WriteText(agent.ITermSessionID, agent.TTY, "check messages"); err != nil {
		log.Printf("nudger: terminal error for %s: %v", sessionID[:8], err)
	}
}
