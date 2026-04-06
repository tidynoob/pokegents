package server

// TerminalIntegration abstracts platform-specific terminal control
// (e.g. iTerm2 on macOS via AppleScript). Non-macOS platforms get a
// stub that returns errors, keeping the server compilable everywhere.
type TerminalIntegration interface {
	// FocusSession brings the terminal session to the foreground.
	FocusSession(itermSessionID, tty string) error
	// WriteText types text into the terminal session.
	WriteText(itermSessionID, tty, text string) error
	// SetTabName changes the tab title of the terminal session.
	SetTabName(itermSessionID, tty, name string) error
	// CloseSession closes the terminal session/tab.
	CloseSession(itermSessionID, tty string) error
	// CloneSession opens a new tab and launches a forked pokegents session.
	CloneSession(profile, sessionIDPrefix string) error
	// ResumeSession opens a new tab and resumes an existing pokegents session.
	// compact: "yes" to auto-compact, "no" to skip, "" to let user decide.
	ResumeSession(profile, sessionID, compact string) error
	// LaunchProfile opens a new tab and starts a fresh pokegents session for the given profile.
	LaunchProfile(profile, itermProfile string) error
	// IsAvailable reports whether the terminal integration is functional
	// on the current platform.
	IsAvailable() bool
	// IsSessionFocused checks if the given session is the currently active/selected
	// terminal session. Used to avoid nudging while the user is typing.
	IsSessionFocused(itermSessionID, tty string) bool
}
