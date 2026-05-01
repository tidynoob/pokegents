package server

// Phase 3 — Chat-backed pokegent supervisor.
//
// Spawns one `@zed-industries/claude-agent-acp` subprocess per chat-mode
// pokegent and bridges it to the dashboard:
//
//   - Speaks JSON-RPC over NDJSON on the subprocess's stdio (Phase 0 spike #2
//     verified the wire format).
//   - Sends `_meta.systemPrompt.append` so role/project system prompts apply
//     to chat-mode agents (Phase 0 spike #1 verified the placement).
//   - Translates `session/update` notifications into the same status / running
//     / activity artifacts the iterm2 hook writes — so downstream consumers
//     (state.go, search index, dashboard UI) don't need to know which backend
//     produced the agent. (Phase 0 spike #3 ruled out reusing status-update.sh
//     directly because the SDK takes JS callback hooks, not shell commands.)
//   - Mailboxes are keyed by pokegent_id (already true after Phase 1 — no
//     supervisor work needed).
//
// Identity / running / status files are written by the unified launch
// endpoint (launch.go) BEFORE this supervisor spawns the subprocess
// (Principle 6). The supervisor just patches `claude_pid` once available
// and updates state on session/update.

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"pokegents/dashboard/server/store"
)

// Tunables. Most are documented inline at point-of-use; collected here so
// they're easy to find when diagnosing slow turns or oversized buffers.
const (
	// chatStderrTailLines bounds the rolling buffer of subprocess stderr
	// kept for crash diagnostics.
	chatStderrTailLines = 32
	// chatPromptTimeout is the upper bound on a single ACP `session/prompt`
	// round-trip. Long Claude turns + tool calls can exceed default HTTP
	// request timeouts; we detach into a goroutine bounded by this. Override
	// via env var POKEGENTS_CHAT_PROMPT_TIMEOUT (Go duration syntax).
	chatPromptTimeout = 30 * time.Minute
)

// ── JSON-RPC envelopes ─────────────────────────────────────

type chatJSONRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type chatRawFrame struct {
	JSONRPC string            `json:"jsonrpc"`
	ID      *int64            `json:"id,omitempty"`
	Method  string            `json:"method,omitempty"`
	Params  json.RawMessage   `json:"params,omitempty"`
	Result  json.RawMessage   `json:"result,omitempty"`
	Error   *chatJSONRPCError `json:"error,omitempty"`
}

type chatRPCResponse struct {
	Result json.RawMessage
	Error  *chatJSONRPCError
}

// ── ACP transport ──────────────────────────────────────────

type chatACPClient struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	writeMu sync.Mutex
	nextID  atomic.Int64
	pending sync.Map // int64 → chan chatRPCResponse

	onNotif func(method string, params json.RawMessage)
	onReq   func(method string, params json.RawMessage) (any, *chatJSONRPCError)

	closed atomic.Bool
	done   chan struct{}
}

func (c *chatACPClient) sendRequest(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("acp client closed")
	}
	id := c.nextID.Add(1)
	pb, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	frame := struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int64           `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}{"2.0", id, method, pb}
	line, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}

	respCh := make(chan chatRPCResponse, 1)
	c.pending.Store(id, respCh)
	defer c.pending.Delete(id)

	if err := c.writeLine(line); err != nil {
		return nil, err
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, fmt.Errorf("acp subprocess exited")
	case resp := <-respCh:
		if resp.Error != nil {
			return nil, fmt.Errorf("acp error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	}
}

func (c *chatACPClient) sendNotification(method string, params any) error {
	if c.closed.Load() {
		return fmt.Errorf("acp client closed")
	}
	pb, err := json.Marshal(params)
	if err != nil {
		return err
	}
	frame := struct {
		JSONRPC string          `json:"jsonrpc"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}{"2.0", method, pb}
	line, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return c.writeLine(line)
}

func (c *chatACPClient) sendResponse(id int64, result any, errResp *chatJSONRPCError) error {
	if c.closed.Load() {
		return fmt.Errorf("acp client closed")
	}
	var line []byte
	if errResp != nil {
		frame := struct {
			JSONRPC string            `json:"jsonrpc"`
			ID      int64             `json:"id"`
			Error   *chatJSONRPCError `json:"error"`
		}{"2.0", id, errResp}
		var err error
		line, err = json.Marshal(frame)
		if err != nil {
			return err
		}
	} else {
		rb, err := json.Marshal(result)
		if err != nil {
			return err
		}
		frame := struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      int64           `json:"id"`
			Result  json.RawMessage `json:"result"`
		}{"2.0", id, rb}
		line, err = json.Marshal(frame)
		if err != nil {
			return err
		}
	}
	return c.writeLine(line)
}

func (c *chatACPClient) writeLine(line []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.stdin.Write(append(line, '\n')); err != nil {
		return err
	}
	return nil
}

func (c *chatACPClient) readLoop() {
	defer close(c.done)
	defer c.closed.Store(true)
	sc := bufio.NewScanner(c.stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var raw chatRawFrame
		if err := json.Unmarshal(line, &raw); err != nil {
			log.Printf("acp: bad frame: %v (%s)", err, string(line))
			continue
		}
		switch {
		case raw.Method == "" && raw.ID != nil:
			if chAny, ok := c.pending.LoadAndDelete(*raw.ID); ok {
				ch := chAny.(chan chatRPCResponse)
				ch <- chatRPCResponse{Result: raw.Result, Error: raw.Error}
			} else {
				log.Printf("acp: response for unknown id=%d", *raw.ID)
			}
		case raw.Method != "" && raw.ID != nil:
			id, method, params := *raw.ID, raw.Method, raw.Params
			go func() {
				if c.onReq == nil {
					_ = c.sendResponse(id, nil, &chatJSONRPCError{Code: -32601, Message: "method not found"})
					return
				}
				result, errResp := c.onReq(method, params)
				_ = c.sendResponse(id, result, errResp)
			}()
		case raw.Method != "" && raw.ID == nil:
			if strings.HasPrefix(raw.Method, "claude/") {
				log.Printf("acp-ext: %s (len=%d)", raw.Method, len(raw.Params))
			}
			if c.onNotif != nil {
				c.onNotif(raw.Method, raw.Params)
			}
		}
	}
	if err := sc.Err(); err != nil {
		log.Printf("acp: read error: %v", err)
	}
}

// ── Chat session (one chat-backed pokegent) ────────────────

// ChatSessionEvent is fanned out to SSE subscribers of /api/chat/{id}/stream.
type ChatSessionEvent struct {
	Type string          `json:"type"` // "session_update" | "permission_request" | "exit" | "state"
	Data json.RawMessage `json:"data"`
}

type ChatSession struct {
	PokegentID string
	ACPID      string // ACP server's session ID (different from pokegent_id; opaque)
	Profile    string
	Cwd        string
	Created    time.Time
	dataDir    string

	client *chatACPClient

	lastUpdated atomic.Int64 // unix millis

	subsMu      sync.Mutex
	subscribers map[chan ChatSessionEvent]struct{}

	// Active background tasks — keyed by taskId. Populated from
	// claude/task_started, removed on claude/task_notification.
	// Replayed to new SSE subscribers so tasks survive page refresh.
	tasksMu     sync.Mutex
	activeTasks map[string]json.RawMessage

	// Status / activity translation buffers. Updated on session/update events
	// and flushed to disk on each turn boundary. Same field set as the bash
	// hooks' status writer (hooks/status-update.sh) so the frontend never
	// branches on backend.
	stateMu        sync.Mutex
	recentActions  []string
	contextTokens  int
	contextWindow  int
	lastSummary         string
	lastSummaryStaging  string // accumulates during a turn; committed on busy→idle
	lastTrace           string
	currentDetail       string
	currentPrompt       string

	// Phase 5: parked ACP `session/request_permission` requests waiting for
	// a user decision. Replayed to any late-connecting SSE subscriber so a
	// panel that opens AFTER a permission prompt fired still sees it.
	permMu       sync.Mutex
	nextPermID   atomic.Int64
	pendingPerms map[int64]*pendingPermission

	// promptCtxCancel aborts the in-flight Prompt() goroutine's sendRequest.
	// Set by Prompt(), called by Cancel(). Guarded by stateMu.
	promptCtxCancel context.CancelFunc

	// intentionalClose is set by Close() to mark a deliberate teardown
	// (migration, user delete). The exit handler checks this and SKIPS
	// status/running file cleanup when true — those are owned by whatever
	// flow initiated the close. Without this, a migration that closes the
	// chat subprocess deletes the new presentation's freshly-written
	// running file in an out-of-order goroutine.
	intentionalClose atomic.Bool

	// stderrTail keeps the last ~32 lines of subprocess stderr so we can log
	// them when the subprocess exits unexpectedly. Without this, silent
	// crashes (e.g. "session_id not found" → SDK aborts) leave no trace and
	// we get a useless `read |0: file already closed` after the fact.
	stderrMu   sync.Mutex
	stderrTail []string

	// State machine — single source of truth for busy/idle (Phase 5)
	smMu         sync.Mutex
	smState      string // "idle" | "busy" | "error"
	smTurnID     uint64
	smSeqNo      uint64
	smBusySince  time.Time
	smCancelWdog *time.Timer

	// Event ring buffer for cursor-based fetch
	eventRingMu  sync.RWMutex
	eventRing    []RuntimeEvent
	eventRingCap int

	// Phase 1: debounce status file writes — streaming chunks fire
	// translateUpdate on every chunk; the debouncer coalesces writes to
	// a 500ms trailing edge. State transitions (busy↔idle) flush immediately.
	statusDebounce *time.Timer

	// Phase 1: direct SSE broadcast to dashboard EventBus, bypassing
	// the file→fsnotify→rebuild indirection for state transitions.
	dashboardBus *EventBus

	// Phase 1: server-side prompt queue — persists queued prompts to
	// ~/.pokegents/queues/{pgid}.json so they survive page refresh.
	queue *PromptQueue
}

type pendingPermission struct {
	requestID int64
	payload   json.RawMessage // wrapped params we broadcast (includes request_id)
	ch        chan permissionDecision
}

type permissionDecision struct {
	OptionID  string
	Cancelled bool
}

func (s *ChatSession) Subscribe() (chan ChatSessionEvent, func()) {
	ch := make(chan ChatSessionEvent, 64)
	s.subsMu.Lock()
	s.subscribers[ch] = struct{}{}
	n := len(s.subscribers)
	s.subsMu.Unlock()
	log.Printf("chat-sse[%s]: subscriber connected (now %d)", shortChat(s.PokegentID), n)
	s.permMu.Lock()
	for _, p := range s.pendingPerms {
		select {
		case ch <- ChatSessionEvent{Type: "permission_request", Data: p.payload}:
		default:
		}
	}
	s.permMu.Unlock()
	// Replay active background tasks so they survive page refresh.
	s.tasksMu.Lock()
	for _, params := range s.activeTasks {
		select {
		case ch <- ChatSessionEvent{Type: "claude/task_started", Data: params}:
		default:
		}
	}
	s.tasksMu.Unlock()
	return ch, func() {
		s.subsMu.Lock()
		delete(s.subscribers, ch)
		n := len(s.subscribers)
		s.subsMu.Unlock()
		log.Printf("chat-sse[%s]: subscriber disconnected (now %d)", shortChat(s.PokegentID), n)
		close(ch)
	}
}

func (s *ChatSession) broadcast(t string, payload json.RawMessage) {
	s.lastUpdated.Store(time.Now().UnixMilli())
	evt := ChatSessionEvent{Type: t, Data: payload}
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	for ch := range s.subscribers {
		select {
		case ch <- evt:
		default:
			log.Printf("chat-sse[%s]: DROPPED %s event (slow client, buffer full)", shortChat(s.PokegentID), t)
		}
	}
}

func (s *ChatSession) handleNotification(method string, params json.RawMessage) {
	// Forward claude/* extension notifications to SSE subscribers.
	if strings.HasPrefix(method, "claude/") {
		// Track active background tasks for replay on new subscriber connect.
		if method == "claude/task_started" {
			var t struct{ TaskId string `json:"taskId"` }
			if json.Unmarshal(params, &t) == nil && t.TaskId != "" {
				s.tasksMu.Lock()
				s.activeTasks[t.TaskId] = params
				s.tasksMu.Unlock()
			}
		} else if method == "claude/task_notification" {
			var t struct{ TaskId string `json:"taskId"` }
			if json.Unmarshal(params, &t) == nil && t.TaskId != "" {
				s.tasksMu.Lock()
				delete(s.activeTasks, t.TaskId)
				s.tasksMu.Unlock()
			}
		}

		// Translate to RuntimeEvent → state machine + ring buffer.
		// applyEvent handles state transitions and side effects (broadcast
		// state, publish agent_state_patch, status file write, queue drain).
		s.smMu.Lock()
		turnID := s.smTurnID
		s.smMu.Unlock()
		if evt, ok := translateACPEvent(method, params, turnID); ok {
			s.applyEvent(evt)
			s.appendEvent(evt)
		}

		// Forward raw event to chat SSE for frontend display (task badges,
		// rate limit warnings, API retry messages). State changes are NOT
		// broadcast here — applyEvent handles that via the "state" event type.
		if method != "claude/session_state" {
			s.broadcast(method, params)
		}
		return
	}
	if method != "session/update" {
		return
	}
	// Debug: log tool_call and tool_call_update payloads to see what ACP sends.
	var peek struct {
		Update struct {
			SessionUpdate string `json:"sessionUpdate"`
		} `json:"update"`
	}
	if json.Unmarshal(params, &peek) == nil &&
		(peek.Update.SessionUpdate == "tool_call" || peek.Update.SessionUpdate == "tool_call_update") {
		log.Printf("ACP_DEBUG %s: %s", peek.Update.SessionUpdate, string(params))
	}
	s.broadcast("session_update", params)
	s.translateUpdate(params)
}

// translateUpdate maps an ACP session/update notification onto the status/
// activity artifacts the iterm2 hook would have written. Keeps state.go,
// search.go, and the rest of the dashboard backend behind the same contract
// regardless of which backend produced the agent.
func (s *ChatSession) translateUpdate(params json.RawMessage) {
	var env struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if err := json.Unmarshal(params, &env); err != nil {
		return
	}
	var disc struct {
		SessionUpdate string `json:"sessionUpdate"`
	}
	if err := json.Unmarshal(env.Update, &disc); err != nil {
		return
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	switch disc.SessionUpdate {
	case "agent_message_chunk":
		var u struct {
			Content struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		_ = json.Unmarshal(env.Update, &u)
		if u.Content.Type == "text" {
			// Accumulate into staging — committed on busy→idle so the
			// AgentCard preview never flashes empty mid-turn.
			s.lastSummaryStaging = truncateChat(s.lastSummaryStaging+u.Content.Text, 280)
			s.currentDetail = ""
		}
	case "tool_call", "tool_call_update":
		// Reset the staging buffer when a new tool call starts so the
		// final committed summary is the LAST assistant text block (after
		// all tools), not the first 280 chars of the entire turn.
		// lastSummary itself is NOT cleared — it retains the previous
		// turn's value until the staging buffer overwrites it on completion.
		if disc.SessionUpdate == "tool_call" {
			s.lastSummaryStaging = ""
		}
		var u struct {
			Title     string `json:"title"`
			Kind      string `json:"kind"`
			Status    string `json:"status"`
			Locations []struct {
				Path string `json:"path"`
			} `json:"locations"`
			RawInput json.RawMessage `json:"rawInput"`
			Content  []struct {
				Type    string          `json:"type"`
				Content json.RawMessage `json:"content"`
				Text    string          `json:"text"`
			} `json:"content"`
		}
		_ = json.Unmarshal(env.Update, &u)
		// Build a "Verb: args" label matching the bash hooks' format
		// ("Bash: ls -la", "Read: /path/to/file"). The kind field is the
		// canonical verb (read, edit, execute, etc.); fall back to title.
		verb := chatVerbLabel(u.Kind)
		if verb == "" {
			verb = u.Title
		}
		args := chatToolArgs(u.RawInput, u.Locations)
		label := verb
		if args != "" {
			label = verb + ": " + truncateChat(args, 80)
		}
		if label != "" {
			s.recentActions = appendCappedChat(s.recentActions, label, 6)
			s.currentDetail = label
		}
		// Extract the first fenced code block from tool result content as
		// last_trace — matches the iterm2 hook's extract_trace behavior.
		if disc.SessionUpdate == "tool_call_update" {
			if trace := chatExtractTrace(u.Content); trace != "" {
				s.lastTrace = trace
			}
		}
	case "usage_update":
		var u struct {
			Used int `json:"used"`
			Size int `json:"size"`
		}
		_ = json.Unmarshal(env.Update, &u)
		s.contextTokens = u.Used
		if u.Size > 0 {
			s.contextWindow = u.Size
		}
	}
	s.debouncedStatusWrite()
}

// debouncedStatusWrite coalesces high-frequency status file writes (e.g. per
// streaming chunk) into a single write per 500ms trailing edge. State
// transitions (busy↔idle, →error) call writeStatusFileLocked directly
// instead — they bypass the debounce for immediate on-disk visibility.
// Caller must hold s.stateMu.
func (s *ChatSession) debouncedStatusWrite() {
	if s.statusDebounce != nil {
		s.statusDebounce.Stop()
	}
	s.statusDebounce = time.AfterFunc(500*time.Millisecond, func() {
		s.stateMu.Lock()
		defer s.stateMu.Unlock()
		s.writeStatusFileLocked()
	})
}

// publishAgentStatePatchWith broadcasts a targeted state update to the
// dashboard SSE EventBus using the provided state values. Called from
// applyEvent which already holds the values under smMu — avoids re-reading
// smState after releasing the lock (TOCTOU).
func (s *ChatSession) publishAgentStatePatchWith(state string, busySince time.Time) {
	if s.dashboardBus == nil {
		return
	}
	busySinceStr := ""
	if !busySince.IsZero() {
		busySinceStr = busySince.UTC().Format(time.RFC3339)
	}
	s.tasksMu.Lock()
	taskCount := len(s.activeTasks)
	s.tasksMu.Unlock()

	s.dashboardBus.Publish("agent_state_patch", map[string]any{
		"pokegent_id":      s.PokegentID,
		"state":            state,
		"busy_since":       busySinceStr,
		"background_tasks": taskCount,
	})
}

func (s *ChatSession) writeStatusFileLocked() {
	// SessionID inside the status file is the *Claude conversation* ID
	// (state.go's `sm.statuses` map keys by agent.SessionID, which is the
	// JSONL filename's UUID — not the pokegent_id). For chat sessions
	// that's s.ACPID. If we wrote out the pokegent_id by mistake the
	// status fields would silently drop on the dashboard side because
	// the lookup misses, AND a phantom AgentState would appear at the
	// pokegent_id key the next time rebuildAgents fires. Skip the write
	// entirely in the brief race window before session/load returns
	// ACPID — the readLoop can fire translateUpdate notifications during
	// that window, and falling back to pokegent_id would corrupt state.
	// The explicit writeStatusFileLocked call at the end of Launch
	// (after ACPID is set) ensures we don't lose any state long-term.
	if s.ACPID == "" {
		return
	}
	s.smMu.Lock()
	state := s.smState
	busySince := ""
	if !s.smBusySince.IsZero() {
		busySince = s.smBusySince.UTC().Format(time.RFC3339)
	}
	s.smMu.Unlock()
	// During a busy turn, prefer the staging buffer so the status file
	// reflects in-progress text. When idle (staging already committed), or
	// when staging is empty (mid tool-call), fall back to the committed
	// lastSummary so the card never flashes empty.
	summary := s.lastSummary
	if s.lastSummaryStaging != "" {
		summary = s.lastSummaryStaging
	}
	_ = writeStatusFile(s.dataDir, s.PokegentID, store.StatusFile{
		SessionID:     s.ACPID,
		State:         state,
		Detail:        s.currentDetail,
		CWD:           s.Cwd,
		BusySince:     busySince,
		LastSummary:   summary,
		LastTrace:     s.lastTrace,
		UserPrompt:    s.currentPrompt,
		RecentActions: append([]string(nil), s.recentActions...),
	})
}

func (s *ChatSession) handleRequest(method string, params json.RawMessage) (any, *chatJSONRPCError) {
	switch method {
	case "fs/read_text_file":
		var p struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(params, &p)
		if p.Path == "" {
			return nil, &chatJSONRPCError{Code: -32602, Message: "missing path"}
		}
		data, err := os.ReadFile(p.Path)
		if err != nil {
			return nil, &chatJSONRPCError{Code: -32000, Message: err.Error()}
		}
		return map[string]any{"content": string(data)}, nil
	case "fs/write_text_file":
		var p struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		_ = json.Unmarshal(params, &p)
		if p.Path == "" {
			return nil, &chatJSONRPCError{Code: -32602, Message: "missing path"}
		}
		if err := os.WriteFile(p.Path, []byte(p.Content), 0o644); err != nil {
			return nil, &chatJSONRPCError{Code: -32000, Message: err.Error()}
		}
		return map[string]any{}, nil
	case "session/request_permission":
		return s.requestPermission(params)
	}
	return nil, &chatJSONRPCError{Code: -32601, Message: "method not found"}
}

// requestPermission auto-allows every permission request — matching the
// `--dangerously-skip-permissions` behaviour of iTerm2-mode agents. The
// agent never blocks waiting for a human click.
func (s *ChatSession) requestPermission(params json.RawMessage) (any, *chatJSONRPCError) {
	var tmp struct {
		Options json.RawMessage `json:"options"`
	}
	_ = json.Unmarshal(params, &tmp)

	var opts []struct {
		OptionID string `json:"optionId"`
		Kind     string `json:"kind"`
	}
	_ = json.Unmarshal(tmp.Options, &opts)

	pick := ""
	for _, o := range opts {
		if o.Kind == "allow_always" {
			pick = o.OptionID
			break
		}
	}
	if pick == "" {
		for _, o := range opts {
			if o.Kind == "allow_once" {
				pick = o.OptionID
				break
			}
		}
	}
	if pick == "" && len(opts) > 0 {
		pick = opts[0].OptionID
	}
	if pick == "" {
		return nil, &chatJSONRPCError{Code: -32000, Message: "no permission options offered"}
	}
	return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": pick}}, nil
}

// DeliverPermission resolves a parked permission request. Called by the HTTP
// handler when the user clicks an option in the chat panel. Returns true if
// the request was found (and not already resolved).
func (s *ChatSession) DeliverPermission(reqID int64, optionID string, cancelled bool) bool {
	s.permMu.Lock()
	pp, ok := s.pendingPerms[reqID]
	s.permMu.Unlock()
	if !ok {
		return false
	}
	select {
	case pp.ch <- permissionDecision{OptionID: optionID, Cancelled: cancelled}:
		return true
	default:
		return false // already resolved
	}
}

func (s *ChatSession) Prompt(ctx context.Context, text string) error {
	log.Printf("chat-prompt[%s]: starting prompt", shortChat(s.PokegentID))
	ctx, cancel := context.WithCancel(ctx)

	// Increment turnID and transition to busy via the state machine.
	s.smMu.Lock()
	s.smTurnID++
	turnID := s.smTurnID
	s.smMu.Unlock()

	s.stateMu.Lock()
	s.promptCtxCancel = cancel
	s.lastSummaryStaging = ""
	s.lastTrace = ""
	s.recentActions = nil
	s.currentPrompt = text
	s.currentDetail = "thinking…"
	acpID := s.ACPID
	s.stateMu.Unlock()

	// State transition through the state machine — broadcasts to both SSE
	// streams, flushes status file, publishes agent_state_patch.
	s.applyEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: turnID})

	// Synthesize a user_message_chunk SSE event so chat panels see the
	// user's prompt regardless of which client submitted it.
	if userPayload, err := json.Marshal(map[string]any{
		"sessionId": acpID,
		"update": map[string]any{
			"sessionUpdate": "user_message_chunk",
			"content":       map[string]any{"type": "text", "text": text},
		},
	}); err == nil {
		s.broadcast("session_update", userPayload)
	}

	var turnErr error
	defer func() {
		cancel()
		s.stateMu.Lock()
		s.promptCtxCancel = nil
		if s.lastSummaryStaging != "" {
			s.lastSummary = s.lastSummaryStaging
		}
		s.lastSummaryStaging = ""
		if turnErr != nil {
			if ctx.Err() != nil {
				s.currentDetail = "cancelled"
			} else {
				s.currentDetail = "error: " + turnErr.Error()
			}
		} else {
			s.currentDetail = "finished"
		}
		s.stateMu.Unlock()

		// Fallback idle: if session_state_changed:idle hasn't already
		// fired (e.g. background tasks finished first), transition now.
		// The turnID guard in applyEvent makes this a no-op if a newer
		// turn has started or if idle was already reached.
		s.applyEvent(RuntimeEvent{Type: EventAgentIdle, TurnID: turnID})
	}()

	prompt, err := buildACPPromptBlocks(text)
	if err != nil {
		turnErr = err
		return err
	}
	_, err = s.client.sendRequest(ctx, "session/prompt", map[string]any{
		"sessionId": acpID,
		"prompt":    prompt,
	})
	turnErr = err
	return err
}

// buildACPPromptBlocks turns a text string with embedded `[Image: <path>]`
// tokens into the array of content blocks that ACP `session/prompt` expects.
// Image tokens are lifted out of the text, the file is read, base64-encoded,
// and emitted as an `image` block; the surrounding text rides as `text`
// blocks. The token format is the same one PromptInput emits when the user
// pastes an image (so iterm2 and chat agents are addressed identically up
// the stack — the difference is only how each runtime resolves the token).
func buildACPPromptBlocks(text string) ([]any, error) {
	tokenRE := regexp.MustCompile(`\[Image:\s+([^\]]+)\]`)
	matches := tokenRE.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return []any{map[string]any{"type": "text", "text": text}}, nil
	}
	blocks := make([]any, 0, len(matches)*2+1)
	cursor := 0
	for _, m := range matches {
		// m = [tokenStart, tokenEnd, pathStart, pathEnd]
		if m[0] > cursor {
			pre := strings.TrimSpace(text[cursor:m[0]])
			if pre != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": pre})
			}
		}
		path := strings.TrimSpace(text[m[2]:m[3]])
		data, err := os.ReadFile(path)
		if err != nil {
			// Image read failed — fall back to including the literal token
			// as text so the agent at least sees the path.
			blocks = append(blocks, map[string]any{"type": "text", "text": text[m[0]:m[1]]})
		} else {
			mime := mimeForImagePath(path)
			blocks = append(blocks, map[string]any{
				"type":     "image",
				"mimeType": mime,
				"data":     base64.StdEncoding.EncodeToString(data),
			})
		}
		cursor = m[1]
	}
	if cursor < len(text) {
		post := strings.TrimSpace(text[cursor:])
		if post != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": post})
		}
	}
	if len(blocks) == 0 {
		blocks = append(blocks, map[string]any{"type": "text", "text": ""})
	}
	return blocks, nil
}

func mimeForImagePath(p string) string {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	}
	return "application/octet-stream"
}

func (s *ChatSession) BroadcastDone() {
	s.broadcast("state", json.RawMessage(`{"state":"idle"}`))
}

func (s *ChatSession) Cancel() error {
	s.stateMu.Lock()
	acpID := s.ACPID
	s.stateMu.Unlock()

	// Do NOT broadcast idle/done immediately. The UI stays in "busy" state
	// until ACP confirms idle via session_state_changed (processed by
	// applyEvent). A 10s watchdog is the safety net for when ACP gets stuck.
	s.smMu.Lock()
	if s.smCancelWdog != nil {
		s.smCancelWdog.Stop()
	}
	turnID := s.smTurnID // capture NOW — if a new prompt starts, the watchdog's stale turnID is harmlessly ignored by applyEvent
	s.smCancelWdog = time.AfterFunc(10*time.Second, func() {
		log.Printf("chat-cancel[%s]: watchdog fired — ACP did not confirm idle within 10s", shortChat(s.PokegentID))
		s.applyEvent(RuntimeEvent{Type: EventAgentIdle, TurnID: turnID})
	})
	s.smMu.Unlock()

	// Send session/cancel to ACP and let it finish naturally. Do NOT cancel
	// the Go context — that would make sendRequest return immediately, the
	// Prompt() defer would fire and broadcast state:idle before ACP finishes
	// its cancel loop. The next prompt would then race with ACP's internal
	// promptRunning flag, causing the ACP to queue-then-cancel it.
	//
	// Instead, ACP processes the cancel, returns the session/prompt response
	// with stopReason:"cancelled", sendRequest receives it normally, and
	// Prompt()'s defer broadcasts state:idle only after ACP is truly done.
	return s.client.sendNotification("session/cancel", map[string]any{"sessionId": acpID})
}

func (s *ChatSession) Close() error {
	s.intentionalClose.Store(true)
	if s.client.cmd.Process != nil {
		_ = s.client.cmd.Process.Kill()
	}
	return nil
}

// ── Manager ────────────────────────────────────────────────

type ChatManager struct {
	mu       sync.RWMutex
	sessions map[string]*ChatSession // by pokegent_id

	// wg tracks the cmd.Wait goroutine spawned per Launch so CloseAll
	// can block until every subprocess's exit handler has returned. Without
	// this, Server.Stop() can return before the chat backends have actually
	// died, leaving zombie ACP processes for the next dashboard's reattach
	// pass to clean up.
	wg sync.WaitGroup

	dataDir      string
	onChange      func()
	dashboardBus *EventBus // Phase 1: direct SSE broadcast
}

func NewChatManager(dataDir string, onChange func(), dashboardBus *EventBus) *ChatManager {
	return &ChatManager{
		sessions:     make(map[string]*ChatSession),
		dataDir:      dataDir,
		onChange:     onChange,
		dashboardBus: dashboardBus,
	}
}

func (m *ChatManager) Get(pokegentID string) *ChatSession {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[pokegentID]
}

// ChatLaunchOptions describes a chat-mode launch invocation. The unified
// launch endpoint resolves identity + writes the running file before calling
// Launch; this struct just carries what the supervisor needs.
type ChatLaunchOptions struct {
	PokegentID         string
	Profile            string
	Cwd                string
	SystemPromptAppend string // appended to claude_code preset; empty for default behavior
	// Model selects the Claude model (e.g. "claude-opus-4-7"). Empty falls
	// back to the SDK default. Forwarded to the @zed-industries/claude-agent-acp
	// wrapper via session/(new|load) `_meta.claudeCode.options.model` —
	// the wrapper's session creation extracts userProvidedOptions from
	// _meta and merges into the SDK's `Options.model`.
	Model string
	// Effort maps to the SDK's thinking budget. Values: "low", "medium",
	// "high", "max". Empty leaves the SDK's default (typically adaptive on
	// recent Opus). See effortToThinkingConfig for the budget mapping.
	Effort string
	// ResumeSessionID, if set, switches `session/new` → `session/load` so the
	// supervisor reattaches to an existing Claude conversation (the JSONL on
	// disk at ~/.claude/projects/{cwd-hash}/{ResumeSessionID}.jsonl).
	// Used for interface migration (Phase 4) and chat-mode resume from PC box.
	ResumeSessionID string
}

// effortToThinkingConfig maps the pokegents "effort" string ("low"/"medium"/
// "high"/"max") onto the SDK's ThinkingConfig shape. Returned object slots
// into `_meta.claudeCode.options.thinking`. Mapping mirrors the user-facing
// Claude CLI's --effort flag; "max" goes adaptive so Claude decides.
// Returns nil for empty/unknown effort — caller skips the field.
func effortToThinkingConfig(effort string) map[string]any {
	switch effort {
	case "low":
		return map[string]any{"type": "enabled", "budgetTokens": 4000}
	case "medium":
		return map[string]any{"type": "enabled", "budgetTokens": 10000}
	case "high":
		return map[string]any{"type": "enabled", "budgetTokens": 32000}
	case "max":
		return map[string]any{"type": "adaptive"}
	}
	return nil
}

func (m *ChatManager) Launch(ctx context.Context, opts ChatLaunchOptions) (*ChatSession, error) {
	if opts.PokegentID == "" {
		return nil, fmt.Errorf("pokegent_id required")
	}
	if opts.Cwd == "" {
		home, _ := os.UserHomeDir()
		opts.Cwd = home
	}
	if !filepath.IsAbs(opts.Cwd) {
		return nil, fmt.Errorf("cwd must be absolute: %q", opts.Cwd)
	}

	acpBin := filepath.Join(filepath.Dir(os.Args[0]), "acp-fork", "dist", "index.js")
	cmd := exec.Command("node", acpBin)
	cmd.Dir = opts.Cwd
	// Mirror Zed: scrub ANTHROPIC_API_KEY so the adapter forces its own auth flow.
	env := os.Environ()
	clean := env[:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, "ANTHROPIC_API_KEY=") {
			continue
		}
		clean = append(clean, kv)
	}
	// Pass POKEGENT_ID + POKEGENTS_SESSION_ID + POKEGENTS_PROFILE_NAME so any
	// SDK-fired hooks (and our own cross-agent messaging surface) can resolve
	// this agent's identity correctly. Mailbox is keyed by pokegent_id.
	clean = append(clean,
		"POKEGENT_ID="+opts.PokegentID,
		"POKEGENTS_SESSION_ID="+opts.PokegentID,
		"POKEGENTS_PROFILE_NAME="+opts.Profile,
	)
	cmd.Env = clean

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("spawn claude-agent-acp: %w", err)
	}

	sess := &ChatSession{
		PokegentID:    opts.PokegentID,
		Profile:       opts.Profile,
		Cwd:           opts.Cwd,
		Created:       time.Now(),
		dataDir:       m.dataDir,
		subscribers:   make(map[chan ChatSessionEvent]struct{}),
		activeTasks:   make(map[string]json.RawMessage),
		recentActions: []string{},
		pendingPerms:  make(map[int64]*pendingPermission),
		smState:       "idle",
		eventRingCap:  2000,
		dashboardBus:  m.dashboardBus,
		queue:         NewPromptQueue(opts.PokegentID),
	}
	sess.lastUpdated.Store(time.Now().UnixMilli())

	// Capture stderr two ways: stream to dashboard log AND keep a ring buffer
	// (sess.stderrTail) so we can dump the last lines on unexpected exit.
	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 16*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			log.Printf("chat[%s/%d]: %s", shortChat(opts.PokegentID), cmd.Process.Pid, line)
			sess.stderrMu.Lock()
			sess.stderrTail = append(sess.stderrTail, line)
			if len(sess.stderrTail) > chatStderrTailLines {
				sess.stderrTail = sess.stderrTail[len(sess.stderrTail)-chatStderrTailLines:]
			}
			sess.stderrMu.Unlock()
		}
	}()

	cli := &chatACPClient{
		cmd: cmd, stdin: stdin, stdout: stdout,
		done: make(chan struct{}),
	}
	cli.onNotif = sess.handleNotification
	cli.onReq = sess.handleRequest
	sess.client = cli

	go cli.readLoop()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		err := cmd.Wait()
		intentional := sess.intentionalClose.Load()
		log.Printf("chat[%s]: process exited (intentional=%v, err=%v)",
			shortChat(opts.PokegentID), intentional, err)
		// On unexpected exits, dump the last stderr lines so we can root-cause
		// silent crashes (the most common: SDK aborts on bad --resume id).
		if !intentional {
			sess.stderrMu.Lock()
			tail := append([]string(nil), sess.stderrTail...)
			sess.stderrMu.Unlock()
			if len(tail) == 0 {
				log.Printf("chat[%s]: no stderr captured before exit — likely the subprocess died before writing anything (npx fetch error? auth?). exit err: %v",
					shortChat(opts.PokegentID), err)
			} else {
				log.Printf("chat[%s]: last %d stderr line(s) before exit:", shortChat(opts.PokegentID), len(tail))
				for _, line := range tail {
					log.Printf("chat[%s]:   %s", shortChat(opts.PokegentID), line)
				}
			}
		}
		sess.broadcast("exit", json.RawMessage(`{}`))
		// Only clean status + running files if this was an UNEXPECTED exit
		// (subprocess crash). Intentional closes (migration, manual delete)
		// hand control to the caller — the migration code writes its own
		// running file, and a stale-deleting goroutine here would race with
		// it. CleanStale's liveness check catches any orphans either way.
		if !sess.intentionalClose.Load() {
			_ = os.Remove(filepath.Join(m.dataDir, "status", opts.PokegentID+".json"))
			matches, _ := filepath.Glob(filepath.Join(m.dataDir, "running", "*-"+opts.PokegentID+".json"))
			for _, p := range matches {
				_ = os.Remove(p)
			}
		}
		m.mu.Lock()
		delete(m.sessions, opts.PokegentID)
		m.mu.Unlock()
		if m.onChange != nil {
			m.onChange()
		}
	}()

	if _, err := cli.sendRequest(ctx, "initialize", map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"fs":       map[string]any{"readTextFile": true, "writeTextFile": true},
			"terminal": false,
		},
		"clientInfo": map[string]any{"name": "pokegents-dashboard", "version": "0.1.0"},
	}); err != nil {
		// Mark intentional so the cmd.Wait goroutine's exit handler doesn't
		// race-delete the running file the caller may be about to roll back.
		sess.intentionalClose.Store(true)
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("acp initialize: %w", err)
	}

	// Either start a fresh session or load an existing one (migration / resume).
	method := "session/new"
	params := map[string]any{
		"cwd":        opts.Cwd,
		"mcpServers": []any{},
	}
	// Build _meta — system prompt append plus claudeCode options block.
	// The Zed @zed-industries/claude-agent-acp wrapper extracts
	// `_meta.claudeCode.options` and spreads them into the underlying SDK
	// Options struct (see acp-agent.js around line 938-960). That's how
	// model + thinking config flow through. Without this, the SDK uses
	// its CLI defaults regardless of what we display in the StatusBar —
	// a "displayed-but-not-applied" mismatch we want to avoid.
	meta := map[string]any{}
	if opts.SystemPromptAppend != "" {
		meta["systemPrompt"] = map[string]any{"append": opts.SystemPromptAppend}
	}
	cc := map[string]any{}
	if opts.Model != "" {
		cc["model"] = opts.Model
	}
	if t := effortToThinkingConfig(opts.Effort); t != nil {
		cc["thinking"] = t
	}
	if len(cc) > 0 {
		meta["claudeCode"] = map[string]any{"options": cc}
	}
	if len(meta) > 0 {
		params["_meta"] = meta
	}
	if opts.ResumeSessionID != "" {
		method = "session/load"
		params["sessionId"] = opts.ResumeSessionID
	}
	resp, err := cli.sendRequest(ctx, method, params)
	if err != nil {
		sess.intentionalClose.Store(true)
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("acp %s: %w", method, err)
	}
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		sess.intentionalClose.Store(true)
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("acp %s bad response: %s", method, string(resp))
	}
	if result.SessionID == "" && opts.ResumeSessionID != "" {
		// `session/load` may return an empty session_id on success — the
		// loaded session keeps its original ID.
		result.SessionID = opts.ResumeSessionID
	}
	if result.SessionID == "" {
		sess.intentionalClose.Store(true)
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("acp %s did not return a session id", method)
	}
	// ACPID is read by translateUpdate (readLoop goroutine) under stateMu
	// and by Prompt/Cancel paths. Set it under the same lock so the Go
	// memory model gives readers a consistent view; without this, the
	// translateUpdate guard `if s.ACPID == ""` could observe an empty
	// string AFTER ACPID has been set on another core.
	sess.stateMu.Lock()
	sess.ACPID = result.SessionID
	sess.stateMu.Unlock()

	// Patch claude_pid into the running file the launch endpoint pre-wrote,
	// and set Claude session_id so state.go can match transcripts.
	patchRunningFileChat(m.dataDir, opts.PokegentID, opts.Profile, cmd.Process.Pid, result.SessionID)

	// Register the session BEFORE the initial status write. Otherwise a
	// concurrent /api/chat/{id}/stream or /api/sessions/{id}/prompt that
	// arrives in this window finds a status file but no in-memory session
	// and 404s. The status write itself is cheap; ordering matters.
	m.mu.Lock()
	m.sessions[opts.PokegentID] = sess
	m.mu.Unlock()

	// Initial "idle" status write so the dashboard sees us immediately.
	sess.stateMu.Lock()
	sess.writeStatusFileLocked()
	sess.stateMu.Unlock()

	if m.onChange != nil {
		m.onChange()
	}
	return sess, nil
}

// repatchRunningFile rewrites the running file for an active chat session
// using its current pid and session_id. Called by migration AFTER the iTerm
// tab cleanup window to defeat pokegent.sh's `rm -f $running_file` on
// shutdown — without this, the chat agent vanishes from the dashboard even
// though its subprocess is alive and processing prompts.
func (m *ChatManager) repatchRunningFile(pokegentID string) {
	m.mu.RLock()
	sess, ok := m.sessions[pokegentID]
	m.mu.RUnlock()
	if !ok || sess == nil {
		return
	}
	pid := 0
	if sess.client != nil && sess.client.cmd != nil && sess.client.cmd.Process != nil {
		pid = sess.client.cmd.Process.Pid
	}
	patchRunningFileChat(m.dataDir, pokegentID, sess.Profile, pid, sess.ACPID)
}

// CloseAll cleanly shuts down every active chat session and waits for
// each subprocess's exit handler to return. Called from the dashboard's
// signal-driven graceful shutdown so a SIGTERM doesn't orphan ACP
// subprocesses (which would otherwise survive as PPID=1 processes the
// next dashboard couldn't re-attach to). Bounded by `timeout` so a stuck
// subprocess can't hang the dashboard shutdown indefinitely — uncollected
// orphans get cleaned up by the next startup's reattach pass.
func (m *ChatManager) CloseAll(timeout time.Duration) {
	m.mu.Lock()
	pgids := make([]string, 0, len(m.sessions))
	for pgid := range m.sessions {
		pgids = append(pgids, pgid)
	}
	m.mu.Unlock()
	for _, pgid := range pgids {
		m.Close(pgid)
	}
	// Wait for cmd.Wait goroutines to drain (their exit handlers do the
	// status/running cleanup and the m.sessions delete). Without this the
	// HTTP server can finish Shutdown while goroutines are still firing
	// m.onChange, racing eventBus consumers that have already been freed.
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		log.Printf("chat: CloseAll timed out after %s with %d session(s) still draining", timeout, len(pgids))
	}
}

func (m *ChatManager) Close(pokegentID string) {
	m.mu.Lock()
	sess, ok := m.sessions[pokegentID]
	if ok {
		delete(m.sessions, pokegentID)
	}
	m.mu.Unlock()
	if sess != nil {
		_ = sess.Close()
		if m.onChange != nil {
			m.onChange()
		}
	}
}

// patchRunningFileChat updates the placeholder running file with the actual
// claude_pid (subprocess PID) and Claude session_id (from session/new response).
func patchRunningFileChat(dataDir, pokegentID, profile string, claudePID int, claudeSessionID string) {
	path := filepath.Join(dataDir, "running", profile+"-"+pokegentID+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var rs map[string]any
	if err := json.Unmarshal(data, &rs); err != nil {
		return
	}
	rs["claude_pid"] = claudePID
	rs["pid"] = claudePID
	rs["session_id"] = claudeSessionID
	rs["ccd_session_id"] = pokegentID // chat backend doesn't have a separate ccd_session_id
	out, err := json.MarshalIndent(rs, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// ── HTTP handlers ──────────────────────────────────────────

func (s *Server) handleChatStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess := s.chatMgr.Get(id)
	if sess == nil {
		http.Error(w, "chat session not found", http.StatusNotFound)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	ch, cleanup := sess.Subscribe()
	defer cleanup()

	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	ctx := r.Context()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			fmt.Fprintf(w, "event: heartbeat\ndata: {}\n\n")
			flusher.Flush()
		case evt, ok := <-ch:
			if !ok {
				return
			}
			data, err := json.Marshal(evt.Data)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Type, data)
			flusher.Flush()
			// On `exit`, end the SSE connection so the browser's
			// EventSource auto-reconnect kicks in. If we kept the loop
			// alive, the client would stay subscribed to a dead session
			// and never see events from a relaunch (e.g. /model, /effort,
			// or chat-reattach). Browser reconnect → fresh subscribe to
			// the new session under the same pgid.
			if evt.Type == "exit" {
				return
			}
		}
	}
}

// handleChatPermission delivers a user's approve/deny choice to a parked
// `session/request_permission` ACP request. The chat panel POSTs here when
// the user clicks one of the option buttons.
func (s *Server) handleChatPermission(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	reqIDStr := r.PathValue("request_id")
	sess := s.chatMgr.Get(id)
	if sess == nil {
		http.Error(w, "chat session not found", http.StatusNotFound)
		return
	}
	reqID, err := strconv.ParseInt(reqIDStr, 10, 64)
	if err != nil {
		http.Error(w, "bad request_id", http.StatusBadRequest)
		return
	}
	var body struct {
		OptionID  string `json:"option_id"`
		Cancelled bool   `json:"cancelled"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !sess.DeliverPermission(reqID, body.OptionID, body.Cancelled) {
		http.Error(w, "no pending permission with that request_id (already resolved or expired)", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── State machine (Phase 0) ───────────────────────────────

// applyEvent implements the v3 transition table. All state transitions and
// their side effects (SSE broadcast, status file write, queue drain) flow
// through here. No other code should broadcast state directly.
func (s *ChatSession) applyEvent(evt RuntimeEvent) {
	s.smMu.Lock()
	if evt.TurnID < s.smTurnID {
		s.smMu.Unlock()
		return
	}

	prevState := s.smState

	switch evt.Type {
	case EventAgentBusy:
		if s.smState != "busy" {
			s.smState = "busy"
			s.smBusySince = time.Now()
		}
	case EventAgentIdle:
		if s.smState == "busy" {
			s.smState = "idle"
			s.smBusySince = time.Time{}
			if s.smCancelWdog != nil {
				s.smCancelWdog.Stop()
				s.smCancelWdog = nil
			}
		}
	case EventError:
		s.smState = "error"
	}

	newState := s.smState
	busySince := s.smBusySince
	s.smMu.Unlock()

	// Side effects on state change.
	if newState != prevState {
		stateJSON, _ := json.Marshal(map[string]string{"state": newState})
		s.broadcast("state", stateJSON)
		s.publishAgentStatePatchWith(newState, busySince)

		s.stateMu.Lock()
		if s.statusDebounce != nil {
			s.statusDebounce.Stop()
		}
		s.writeStatusFileLocked()
		s.stateMu.Unlock()

		if newState == "idle" {
			s.drainQueue()
		}
	}
}

// drainQueue pops the next prompt from the server-side queue and sends it.
// Called by applyEvent on busy→idle transitions.
func (s *ChatSession) drainQueue() {
	if s.queue == nil {
		return
	}
	item, ok := s.queue.Dequeue()
	if !ok {
		return
	}
	if s.client == nil {
		log.Printf("chat-queue[%s]: no ACP client, cannot drain", shortChat(s.PokegentID))
		return
	}
	log.Printf("chat-queue[%s]: draining queued prompt (len=%d remaining)", shortChat(s.PokegentID), s.queue.Len())
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), chatPromptTimeout)
		defer cancel()
		if err := s.Prompt(ctx, item.Text); err != nil {
			log.Printf("chat-queue[%s]: drain error: %v", shortChat(s.PokegentID), err)
		}
	}()
}

// SubmitPrompt checks the state machine and either sends immediately or
// enqueues. Returns (true, nil) if queued. Sets smState="busy" under the
// lock before launching the goroutine to prevent a second concurrent
// caller from also seeing idle and launching a duplicate Prompt().
func (s *ChatSession) SubmitPrompt(text, nonce string) (queued bool, err error) {
	s.smMu.Lock()
	if s.smState == "busy" {
		s.smMu.Unlock()
		s.queue.Enqueue(text, nonce)
		return true, nil
	}
	s.smState = "busy"
	s.smBusySince = time.Now()
	s.smMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), chatPromptTimeout)
		defer cancel()
		if err := s.Prompt(ctx, text); err != nil {
			log.Printf("chat prompt error (%s): %v", shortChat(s.PokegentID), err)
		}
	}()
	return false, nil
}

func (s *ChatSession) appendEvent(evt RuntimeEvent) {
	s.eventRingMu.Lock()
	defer s.eventRingMu.Unlock()
	s.smSeqNo++
	evt.SeqNo = s.smSeqNo
	s.eventRing = append(s.eventRing, evt)
	if len(s.eventRing) > s.eventRingCap {
		s.eventRing = s.eventRing[len(s.eventRing)-s.eventRingCap:]
	}
}

func (s *ChatSession) EventsSince(seqNo uint64) (events []RuntimeEvent, hasGap bool) {
	s.eventRingMu.RLock()
	defer s.eventRingMu.RUnlock()
	if len(s.eventRing) == 0 {
		return nil, false
	}
	oldest := s.eventRing[0].SeqNo
	if seqNo > 0 && seqNo+1 < oldest {
		result := make([]RuntimeEvent, len(s.eventRing))
		copy(result, s.eventRing)
		return result, true
	}
	for i, evt := range s.eventRing {
		if evt.SeqNo > seqNo {
			result := make([]RuntimeEvent, len(s.eventRing)-i)
			copy(result, s.eventRing[i:])
			return result, false
		}
	}
	return nil, false
}

func (s *ChatSession) StopTask(taskId string) error {
	return fmt.Errorf("StopTask not yet implemented")
}

func translateACPEvent(acpSubtype string, payload json.RawMessage, turnID uint64) (RuntimeEvent, bool) {
	switch acpSubtype {
	case "claude/session_state":
		var d struct{ State string `json:"state"` }
		if json.Unmarshal(payload, &d) != nil {
			return RuntimeEvent{}, false
		}
		switch d.State {
		case "busy", "processing", "waiting":
			return RuntimeEvent{Type: EventAgentBusy, TurnID: turnID, Payload: payload}, true
		case "idle":
			return RuntimeEvent{Type: EventAgentIdle, TurnID: turnID, Payload: payload}, true
		default:
			return RuntimeEvent{}, false
		}
	case "claude/task_started":
		return RuntimeEvent{Type: EventTaskStarted, TurnID: turnID, Payload: payload}, true
	case "claude/task_notification":
		var d struct{ Status string `json:"status"` }
		if json.Unmarshal(payload, &d) == nil && (d.Status == "completed" || d.Status == "stopped" || d.Status == "failed") {
			return RuntimeEvent{Type: EventTaskCompleted, TurnID: turnID, Payload: payload}, true
		}
		return RuntimeEvent{Type: EventTaskProgress, TurnID: turnID, Payload: payload}, true
	case "claude/task_progress":
		return RuntimeEvent{Type: EventTaskProgress, TurnID: turnID, Payload: payload}, true
	case "claude/api_retry":
		return RuntimeEvent{Type: EventAPIRetry, TurnID: turnID, Payload: payload}, true
	case "claude/rate_limit_event":
		return RuntimeEvent{Type: EventRateLimit, TurnID: turnID, Payload: payload}, true
	default:
		return RuntimeEvent{}, false
	}
}

// ── Helpers ────────────────────────────────────────────────

func shortChat(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

func truncateChat(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func appendCappedChat(slice []string, s string, cap int) []string {
	slice = append(slice, s)
	if len(slice) > cap {
		slice = slice[len(slice)-cap:]
	}
	return slice
}

// chatVerbLabel maps an ACP tool kind onto the same verb the bash hooks
// emit (e.g. "Bash", "Read", "Edit"), so recent_actions reads identically
// across runtimes.
func chatVerbLabel(kind string) string {
	switch kind {
	case "execute":
		return "Bash"
	case "read":
		return "Read"
	case "edit":
		return "Edit"
	case "search":
		return "Grep"
	case "fetch":
		return "WebFetch"
	case "think":
		return "Think"
	case "other":
		return "Tool"
	}
	if kind == "" {
		return ""
	}
	// Capitalize first letter for unknown kinds.
	return strings.ToUpper(kind[:1]) + kind[1:]
}

// chatToolArgs derives a one-line "args" string for a tool call. Prefers
// rawInput common fields (command, file_path, pattern, query, description),
// falls back to the first location path. Mirrors the bash hook's logic.
func chatToolArgs(raw json.RawMessage, locations []struct {
	Path string `json:"path"`
}) string {
	if len(raw) > 0 {
		var fields struct {
			Command     string `json:"command"`
			FilePath    string `json:"file_path"`
			Path        string `json:"path"`
			Pattern     string `json:"pattern"`
			Query       string `json:"query"`
			Description string `json:"description"`
		}
		if err := json.Unmarshal(raw, &fields); err == nil {
			for _, v := range []string{fields.Command, fields.FilePath, fields.Path, fields.Pattern, fields.Query, fields.Description} {
				if v != "" {
					return v
				}
			}
		}
	}
	if len(locations) > 0 {
		return locations[0].Path
	}
	return ""
}

// chatExtractTrace pulls the first fenced code block out of a tool result's
// content array (ACP returns content as []{type, content/text}). Matches the
// bash hook's `extract_trace` behavior so AgentCard's last_trace renders
// uniformly.
func chatExtractTrace(content []struct {
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
	Text    string          `json:"text"`
}) string {
	for _, c := range content {
		var text string
		if c.Text != "" {
			text = c.Text
		} else if len(c.Content) > 0 {
			var inner struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal(c.Content, &inner); err == nil {
				text = inner.Text
			} else {
				_ = json.Unmarshal(c.Content, &text)
			}
		}
		if text == "" {
			continue
		}
		// First fenced block, if present.
		if i := strings.Index(text, "```"); i >= 0 {
			rest := text[i+3:]
			if nl := strings.Index(rest, "\n"); nl >= 0 {
				rest = rest[nl+1:]
			}
			if end := strings.Index(rest, "```"); end >= 0 {
				return strings.TrimSpace(rest[:end])
			}
		}
		// No fence — use up to 500 chars of plain text.
		return truncateChat(strings.TrimSpace(text), 500)
	}
	return ""
}
