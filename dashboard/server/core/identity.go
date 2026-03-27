package core

import "strings"

// Agent is the minimal info needed for identity resolution.
// Implemented by store.RunningSession and server.AgentState.
type Agent interface {
	GetSessionID() string
	GetCCDSessionID() string
	GetDisplayName() string
	GetTTY() string
}

// ResolveToSessionID finds the Claude session ID for a given ID (which could
// be a session_id, ccd_session_id, or 8-char prefix of either).
// Returns the input unchanged if no match is found.
func ResolveToSessionID(agents []Agent, id string) string {
	// Pass 1: exact or prefix match on session_id
	for _, a := range agents {
		sid := a.GetSessionID()
		if sid == id || strings.HasPrefix(sid, id) {
			return sid
		}
	}
	// Pass 2: exact or prefix match on ccd_session_id (skip if same as session_id)
	for _, a := range agents {
		ccd := a.GetCCDSessionID()
		if ccd != "" && ccd != a.GetSessionID() {
			if ccd == id || strings.HasPrefix(ccd, id) {
				return a.GetSessionID()
			}
		}
	}
	return id
}

// ResolveToCCDSessionID finds the stable CCD session ID for a given ID.
// This is the mailbox routing key — unique per agent, even for clones.
func ResolveToCCDSessionID(agents []Agent, id string) string {
	// Pass 1: match on ccd_session_id
	for _, a := range agents {
		ccd := a.GetCCDSessionID()
		if ccd != "" && (ccd == id || strings.HasPrefix(ccd, id)) {
			return ccd
		}
	}
	// Pass 2: match on session_id → return its ccd_session_id
	for _, a := range agents {
		sid := a.GetSessionID()
		if sid == id || strings.HasPrefix(sid, id) {
			if ccd := a.GetCCDSessionID(); ccd != "" {
				return ccd
			}
			return sid
		}
	}
	return id
}

// ResolveAgent finds the agent matching the given ID (any type, any prefix length).
func ResolveAgent(agents []Agent, id string) Agent {
	// Pass 1: session_id
	for _, a := range agents {
		sid := a.GetSessionID()
		if sid == id || strings.HasPrefix(sid, id) {
			return a
		}
	}
	// Pass 2: ccd_session_id
	for _, a := range agents {
		ccd := a.GetCCDSessionID()
		if ccd != "" && (ccd == id || strings.HasPrefix(ccd, id)) {
			return a
		}
	}
	return nil
}
