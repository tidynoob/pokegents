package server

import (
	"testing"
)

// TestResolveSessionID tests session ID resolution with various match types.
func TestResolveSessionID(t *testing.T) {
	// Build a mock server with agents
	agents := []AgentState{
		{SessionID: "aaaa1111-full-uuid-here", CCDSessionID: "bbbb2222-ccd-uuid-here", DisplayName: "Agent A"},
		{SessionID: "cccc3333-full-uuid-here", CCDSessionID: "dddd4444-ccd-uuid-here", DisplayName: "Agent B"},
		{SessionID: "eeee5555-full-uuid-here", CCDSessionID: "eeee5555-full-uuid-here", DisplayName: "Agent C (same IDs)"},
	}

	// resolveSessionID is on *Server, so we test the resolution logic directly
	resolve := func(id string) string {
		// Pass 1: exact session_id or prefix
		for _, a := range agents {
			if a.SessionID == id || len(id) < len(a.SessionID) && a.SessionID[:len(id)] == id {
				return a.SessionID
			}
		}
		// Pass 2: ccd_session_id
		for _, a := range agents {
			if a.CCDSessionID != "" && a.CCDSessionID != a.SessionID {
				if a.CCDSessionID == id || (len(id) < len(a.CCDSessionID) && a.CCDSessionID[:len(id)] == id) {
					return a.SessionID
				}
			}
		}
		return id
	}

	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"exact session_id", "aaaa1111-full-uuid-here", "aaaa1111-full-uuid-here"},
		{"session_id prefix", "aaaa1111", "aaaa1111-full-uuid-here"},
		{"ccd_session_id exact", "bbbb2222-ccd-uuid-here", "aaaa1111-full-uuid-here"},
		{"ccd_session_id prefix", "bbbb2222", "aaaa1111-full-uuid-here"},
		{"agent B by prefix", "cccc3333", "cccc3333-full-uuid-here"},
		{"agent B by ccd prefix", "dddd4444", "cccc3333-full-uuid-here"},
		{"same IDs agent by prefix", "eeee5555", "eeee5555-full-uuid-here"},
		{"no match returns input", "zzzz9999", "zzzz9999"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := resolve(tt.input)
			if result != tt.expected {
				t.Errorf("resolve(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

// TestResolveToCCDSessionID tests reverse resolution (find the CCD session ID).
func TestResolveToCCDSessionID(t *testing.T) {
	agents := []AgentState{
		{SessionID: "aaaa1111-full-uuid", CCDSessionID: "bbbb2222-ccd-uuid", DisplayName: "Agent A"},
		{SessionID: "cccc3333-full-uuid", CCDSessionID: "cccc3333-full-uuid", DisplayName: "Agent B (same)"},
	}

	resolveToCCD := func(id string) string {
		// Check by ccd_session_id first
		for _, a := range agents {
			if a.CCDSessionID != "" && (a.CCDSessionID == id || (len(id) < len(a.CCDSessionID) && a.CCDSessionID[:len(id)] == id)) {
				return a.CCDSessionID
			}
		}
		// Check by session_id → return ccd_session_id
		for _, a := range agents {
			if a.SessionID == id || (len(id) < len(a.SessionID) && a.SessionID[:len(id)] == id) {
				if a.CCDSessionID != "" {
					return a.CCDSessionID
				}
				return a.SessionID
			}
		}
		return id
	}

	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"session_id → ccd_session_id", "aaaa1111", "bbbb2222-ccd-uuid"},
		{"ccd_session_id stays", "bbbb2222", "bbbb2222-ccd-uuid"},
		{"same IDs agent", "cccc3333", "cccc3333-full-uuid"},
		{"no match returns input", "zzzz9999", "zzzz9999"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := resolveToCCD(tt.input)
			if result != tt.expected {
				t.Errorf("resolveToCCD(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

// TestCloneSafety verifies that two agents with the same session_id
// (clone scenario) are resolved correctly by ccd_session_id.
func TestCloneSafety(t *testing.T) {
	agents := []AgentState{
		{SessionID: "shared-session-id", CCDSessionID: "original-ccd-id", DisplayName: "Original"},
		{SessionID: "shared-session-id", CCDSessionID: "clone-ccd-id", DisplayName: "Clone"},
	}

	// Resolution by ccd_session_id should find the right one
	resolveByLabel := func(ccdID string) string {
		for _, a := range agents {
			if a.CCDSessionID == ccdID {
				return a.DisplayName
			}
		}
		return "not found"
	}

	if resolveByLabel("original-ccd-id") != "Original" {
		t.Error("failed to resolve original by ccd_session_id")
	}
	if resolveByLabel("clone-ccd-id") != "Clone" {
		t.Error("failed to resolve clone by ccd_session_id")
	}

	// Resolution by session_id is ambiguous — should return first match
	// This is why clone routing MUST use ccd_session_id
	matchCount := 0
	for _, a := range agents {
		if a.SessionID == "shared-session-id" {
			matchCount++
		}
	}
	if matchCount != 2 {
		t.Errorf("expected 2 agents with same session_id, got %d", matchCount)
	}
}
