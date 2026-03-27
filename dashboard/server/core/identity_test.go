package core

import "testing"

// mockAgent implements the Agent interface for testing.
type mockAgent struct {
	sessionID    string
	ccdSessionID string
	displayName  string
	tty          string
}

func (a *mockAgent) GetSessionID() string    { return a.sessionID }
func (a *mockAgent) GetCCDSessionID() string { return a.ccdSessionID }
func (a *mockAgent) GetDisplayName() string  { return a.displayName }
func (a *mockAgent) GetTTY() string          { return a.tty }

func agents() []Agent {
	return []Agent{
		&mockAgent{"aaaa1111-full", "bbbb2222-ccd", "Agent A", "/dev/ttys001"},
		&mockAgent{"cccc3333-full", "dddd4444-ccd", "Agent B", "/dev/ttys002"},
		&mockAgent{"eeee5555-same", "eeee5555-same", "Agent C", "/dev/ttys003"},
	}
}

func TestResolveToSessionID(t *testing.T) {
	a := agents()
	tests := []struct {
		name, input, want string
	}{
		{"exact session_id", "aaaa1111-full", "aaaa1111-full"},
		{"prefix session_id", "aaaa1111", "aaaa1111-full"},
		{"exact ccd_session_id", "bbbb2222-ccd", "aaaa1111-full"},
		{"prefix ccd_session_id", "bbbb2222", "aaaa1111-full"},
		{"agent B prefix", "cccc3333", "cccc3333-full"},
		{"agent B ccd prefix", "dddd4444", "cccc3333-full"},
		{"same IDs agent", "eeee5555", "eeee5555-same"},
		{"no match", "zzzz9999", "zzzz9999"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveToSessionID(a, tt.input)
			if got != tt.want {
				t.Errorf("ResolveToSessionID(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestResolveToCCDSessionID(t *testing.T) {
	a := agents()
	tests := []struct {
		name, input, want string
	}{
		{"session_id → ccd", "aaaa1111", "bbbb2222-ccd"},
		{"ccd_session_id stays", "bbbb2222", "bbbb2222-ccd"},
		{"same IDs", "eeee5555", "eeee5555-same"},
		{"no match", "zzzz9999", "zzzz9999"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveToCCDSessionID(a, tt.input)
			if got != tt.want {
				t.Errorf("ResolveToCCDSessionID(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestResolveAgent(t *testing.T) {
	a := agents()

	got := ResolveAgent(a, "aaaa1111")
	if got == nil || got.GetDisplayName() != "Agent A" {
		t.Error("failed to resolve Agent A by session_id prefix")
	}

	got = ResolveAgent(a, "dddd4444")
	if got == nil || got.GetDisplayName() != "Agent B" {
		t.Error("failed to resolve Agent B by ccd_session_id prefix")
	}

	got = ResolveAgent(a, "zzzz9999")
	if got != nil {
		t.Error("expected nil for no match")
	}
}

func TestCloneSafety(t *testing.T) {
	// Two agents share session_id but have different ccd_session_ids
	cloneAgents := []Agent{
		&mockAgent{"shared-id", "original-ccd", "Original", ""},
		&mockAgent{"shared-id", "clone-ccd", "Clone", ""},
	}

	// ResolveToCCDSessionID should find the right one
	got := ResolveToCCDSessionID(cloneAgents, "original-ccd")
	if got != "original-ccd" {
		t.Errorf("expected original-ccd, got %s", got)
	}
	got = ResolveToCCDSessionID(cloneAgents, "clone-ccd")
	if got != "clone-ccd" {
		t.Errorf("expected clone-ccd, got %s", got)
	}

	// ResolveAgent by ccd_session_id finds correct clone
	a := ResolveAgent(cloneAgents, "clone-ccd")
	if a == nil || a.GetDisplayName() != "Clone" {
		t.Error("ResolveAgent should find Clone by ccd_session_id")
	}
}
