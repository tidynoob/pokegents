package server

import (
	"encoding/json"
	"testing"
	"time"
)

func newTestSession() *ChatSession {
	return &ChatSession{
		PokegentID:   "test-pgid",
		smState:      "idle",
		eventRingCap: 2000,
		subscribers:  make(map[chan ChatSessionEvent]struct{}),
		queue:        &PromptQueue{},
	}
}

func TestStateMachine_IdleToBusy(t *testing.T) {
	s := newTestSession()
	s.applyEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: 1})
	if s.smState != "busy" {
		t.Fatalf("expected busy, got %s", s.smState)
	}
	if s.smBusySince.IsZero() {
		t.Fatal("busySince should be set")
	}
}

func TestStateMachine_BusyToIdle(t *testing.T) {
	s := newTestSession()
	s.applyEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: 1})
	s.smCancelWdog = time.NewTimer(10 * time.Second)
	s.applyEvent(RuntimeEvent{Type: EventAgentIdle, TurnID: 1})
	if s.smState != "idle" {
		t.Fatalf("expected idle, got %s", s.smState)
	}
	if !s.smBusySince.IsZero() {
		t.Fatal("busySince should be cleared")
	}
	if s.smCancelWdog != nil {
		t.Fatal("watchdog should be cleared")
	}
}

func TestStateMachine_IdleIdleNoop(t *testing.T) {
	s := newTestSession()
	s.applyEvent(RuntimeEvent{Type: EventAgentIdle, TurnID: 1})
	if s.smState != "idle" {
		t.Fatalf("expected idle, got %s", s.smState)
	}
	if !s.smBusySince.IsZero() {
		t.Fatal("busySince should remain zero")
	}
}

func TestStateMachine_BusyBusyIdempotent(t *testing.T) {
	s := newTestSession()
	s.applyEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: 1})
	first := s.smBusySince
	time.Sleep(time.Millisecond)
	s.applyEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: 1})
	if s.smState != "busy" {
		t.Fatalf("expected busy, got %s", s.smState)
	}
	if s.smBusySince != first {
		t.Fatal("busySince should not change on duplicate busy")
	}
}

func TestStateMachine_TurnIDGuard(t *testing.T) {
	s := newTestSession()
	s.smTurnID = 5
	s.applyEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: 3})
	if s.smState != "idle" {
		t.Fatalf("stale turnID should be ignored, state is %s", s.smState)
	}
}

func TestStateMachine_ErrorToBusy(t *testing.T) {
	s := newTestSession()
	s.applyEvent(RuntimeEvent{Type: EventError, TurnID: 1})
	if s.smState != "error" {
		t.Fatalf("expected error, got %s", s.smState)
	}
	s.applyEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: 2})
	if s.smState != "busy" {
		t.Fatalf("expected busy after error, got %s", s.smState)
	}
}

func TestStateMachine_TaskEventsNoStateChange(t *testing.T) {
	s := newTestSession()
	s.applyEvent(RuntimeEvent{Type: EventTaskStarted, TurnID: 1})
	if s.smState != "idle" {
		t.Fatalf("task_started should not change state, got %s", s.smState)
	}
	s.applyEvent(RuntimeEvent{Type: EventTaskProgress, TurnID: 1})
	if s.smState != "idle" {
		t.Fatalf("task_progress should not change state, got %s", s.smState)
	}
	s.applyEvent(RuntimeEvent{Type: EventTaskCompleted, TurnID: 1})
	if s.smState != "idle" {
		t.Fatalf("task_completed should not change state, got %s", s.smState)
	}
}

func TestStateMachine_QueueDrainOnIdle(t *testing.T) {
	s := newTestSession()
	s.queue.Enqueue("queued prompt", "nonce-1")
	s.applyEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: 1})
	if s.queue.Len() != 1 {
		t.Fatal("queue should still have 1 item while busy")
	}
	// applyEvent on idle calls drainQueue which Dequeues synchronously
	// then fires Prompt in a goroutine. We just verify the dequeue — the
	// goroutine will panic (no ACP client) but the test doesn't wait for it.
	s.applyEvent(RuntimeEvent{Type: EventAgentIdle, TurnID: 1})
	if s.queue.Len() != 0 {
		t.Fatalf("queue should be drained on idle, got %d", s.queue.Len())
	}
}

func TestStateMachine_NoDrainOnStaleIdle(t *testing.T) {
	s := newTestSession()
	s.smTurnID = 5
	s.queue.Enqueue("should not drain", "nonce-2")
	s.smState = "busy"
	// Stale event — should be ignored, queue stays full.
	s.applyEvent(RuntimeEvent{Type: EventAgentIdle, TurnID: 3})
	if s.smState != "busy" {
		t.Fatal("stale idle should not change state")
	}
	if s.queue.Len() != 1 {
		t.Fatal("queue should not drain on stale turnID")
	}
}

func TestStateMachine_HandleNotificationWiring(t *testing.T) {
	s := newTestSession()
	s.activeTasks = make(map[string]json.RawMessage)
	s.smTurnID = 1
	// Simulate a claude/session_state:busy event
	payload := json.RawMessage(`{"state":"busy"}`)
	evt, ok := translateACPEvent("claude/session_state", payload, s.smTurnID)
	if !ok {
		t.Fatal("should translate session_state")
	}
	s.applyEvent(evt)
	s.appendEvent(evt)
	if s.smState != "busy" {
		t.Fatalf("expected busy, got %s", s.smState)
	}
	events, _ := s.EventsSince(0)
	if len(events) != 1 {
		t.Fatalf("expected 1 event in ring, got %d", len(events))
	}
}

func TestStateMachine_RingBuffer(t *testing.T) {
	s := newTestSession()
	s.appendEvent(RuntimeEvent{Type: EventAgentBusy, TurnID: 1})
	s.appendEvent(RuntimeEvent{Type: EventTaskStarted, TurnID: 1})
	s.appendEvent(RuntimeEvent{Type: EventAgentIdle, TurnID: 1})

	events, gap := s.EventsSince(0)
	if gap {
		t.Fatal("should not have gap")
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
	if events[0].SeqNo != 1 || events[1].SeqNo != 2 || events[2].SeqNo != 3 {
		t.Fatalf("unexpected seqNos: %d, %d, %d", events[0].SeqNo, events[1].SeqNo, events[2].SeqNo)
	}

	// Fetch since seqNo=2 should return only the third event
	events, gap = s.EventsSince(2)
	if gap {
		t.Fatal("should not have gap")
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].SeqNo != 3 {
		t.Fatalf("expected seqNo 3, got %d", events[0].SeqNo)
	}

	// Fetch since latest should return nothing
	events, gap = s.EventsSince(3)
	if gap {
		t.Fatal("should not have gap")
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

func TestStateMachine_RingBufferOverflow(t *testing.T) {
	s := newTestSession()
	s.eventRingCap = 5

	for i := 0; i < 10; i++ {
		s.appendEvent(RuntimeEvent{Type: EventTaskProgress, TurnID: 1})
	}

	// SeqNo 1-5 are gone, buffer has 6-10. Asking for seqNo=3 should detect gap.
	events, gap := s.EventsSince(3)
	if !gap {
		t.Fatal("expected gap detection")
	}
	if len(events) != 5 {
		t.Fatalf("expected 5 events (full buffer), got %d", len(events))
	}
	if events[0].SeqNo != 6 {
		t.Fatalf("expected oldest seqNo=6, got %d", events[0].SeqNo)
	}
}

func TestStateMachine_TranslateACPEvent_SessionState(t *testing.T) {
	tests := []struct {
		state    string
		wantType RuntimeEventType
		wantOK   bool
	}{
		{"busy", EventAgentBusy, true},
		{"processing", EventAgentBusy, true},
		{"waiting", EventAgentBusy, true},
		{"idle", EventAgentIdle, true},
		{"unknown", "", false},
	}
	for _, tt := range tests {
		payload, _ := json.Marshal(map[string]string{"state": tt.state})
		evt, ok := translateACPEvent("claude/session_state", json.RawMessage(payload), 1)
		if ok != tt.wantOK {
			t.Fatalf("state=%q: ok=%v, want %v", tt.state, ok, tt.wantOK)
		}
		if ok && evt.Type != tt.wantType {
			t.Fatalf("state=%q: type=%s, want %s", tt.state, evt.Type, tt.wantType)
		}
	}
}

func TestStateMachine_TranslateACPEvent_TaskStarted(t *testing.T) {
	payload := json.RawMessage(`{"taskId":"t1"}`)
	evt, ok := translateACPEvent("claude/task_started", payload, 5)
	if !ok {
		t.Fatal("expected ok")
	}
	if evt.Type != EventTaskStarted {
		t.Fatalf("expected task_started, got %s", evt.Type)
	}
	if evt.TurnID != 5 {
		t.Fatalf("expected turnID=5, got %d", evt.TurnID)
	}
}

func TestStateMachine_TranslateACPEvent_TaskNotification(t *testing.T) {
	// completed
	payload, _ := json.Marshal(map[string]string{"status": "completed"})
	evt, ok := translateACPEvent("claude/task_notification", json.RawMessage(payload), 1)
	if !ok || evt.Type != EventTaskCompleted {
		t.Fatalf("expected task_completed, got ok=%v type=%s", ok, evt.Type)
	}

	// stopped
	payload, _ = json.Marshal(map[string]string{"status": "stopped"})
	evt, ok = translateACPEvent("claude/task_notification", json.RawMessage(payload), 1)
	if !ok || evt.Type != EventTaskCompleted {
		t.Fatalf("expected task_completed for stopped, got ok=%v type=%s", ok, evt.Type)
	}

	// failed
	payload, _ = json.Marshal(map[string]string{"status": "failed"})
	evt, ok = translateACPEvent("claude/task_notification", json.RawMessage(payload), 1)
	if !ok || evt.Type != EventTaskCompleted {
		t.Fatalf("expected task_completed for failed, got ok=%v type=%s", ok, evt.Type)
	}

	// running (progress)
	payload, _ = json.Marshal(map[string]string{"status": "running"})
	evt, ok = translateACPEvent("claude/task_notification", json.RawMessage(payload), 1)
	if !ok || evt.Type != EventTaskProgress {
		t.Fatalf("expected task_progress for running, got ok=%v type=%s", ok, evt.Type)
	}
}

func TestStateMachine_TranslateACPEvent_APIRetry(t *testing.T) {
	payload := json.RawMessage(`{"attempt":2}`)
	evt, ok := translateACPEvent("claude/api_retry", payload, 3)
	if !ok || evt.Type != EventAPIRetry {
		t.Fatalf("expected api_retry, got ok=%v type=%s", ok, evt.Type)
	}
}

func TestStateMachine_TranslateACPEvent_RateLimit(t *testing.T) {
	payload := json.RawMessage(`{}`)
	evt, ok := translateACPEvent("claude/rate_limit_event", payload, 1)
	if !ok || evt.Type != EventRateLimit {
		t.Fatalf("expected rate_limit, got ok=%v type=%s", ok, evt.Type)
	}
}

func TestStateMachine_TranslateACPEvent_Unknown(t *testing.T) {
	_, ok := translateACPEvent("claude/unknown_thing", json.RawMessage(`{}`), 1)
	if ok {
		t.Fatal("unknown subtype should return false")
	}
}
