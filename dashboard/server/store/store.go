// Package store provides file-backed storage for pokegents session data.
// All file I/O is centralized here — consumers use interfaces, never os.ReadFile directly.
package store

// Store aggregates all sub-stores. Pass this to SessionManager, MessageService, etc.
type Store struct {
	Running   RunningStore
	Status    StatusStore
	Profiles  ProfileStore
	Config    ConfigStore
	Messages  MessageStore
	Activity  ActivityStore
}

// RunningStore manages active session registry files (~/.pokegents/running/*.json).
type RunningStore interface {
	// Get returns a single running session by Claude session ID.
	Get(sessionID string) (*RunningSession, error)
	// GetByCCDSessionID returns a running session by its stable CCD session ID.
	GetByCCDSessionID(ccdSessionID string) (*RunningSession, error)
	// List returns all running sessions.
	List() ([]RunningSession, error)
	// Create writes a new running session file.
	Create(rs RunningSession) error
	// Update atomically reads, modifies, and writes a running session.
	Update(sessionID string, fn func(*RunningSession)) error
	// Delete removes a running session file.
	Delete(sessionID string) error
	// Watch returns a channel of file change events.
	Watch() <-chan FileEvent
}

// StatusStore manages agent status files (~/.pokegents/status/*.json).
type StatusStore interface {
	// Get returns a single status file by session ID.
	Get(sessionID string) (*StatusFile, error)
	// Upsert creates or updates a status file.
	Upsert(sf StatusFile) error
	// Delete removes a status file.
	Delete(sessionID string) error
	// List returns all status files.
	List() ([]StatusFile, error)
	// Watch returns a channel of file change events.
	Watch() <-chan FileEvent
}

// ProfileStore manages profile configuration files (~/.pokegents/profiles/*.json).
type ProfileStore interface {
	// Get returns a profile by name.
	Get(name string) (*Profile, error)
	// List returns all profiles.
	List() ([]Profile, error)
}

// ConfigStore manages the global config file (~/.pokegents/config.json).
type ConfigStore interface {
	// Get returns the current configuration.
	Get() (*AppConfig, error)
}

// MessageStore manages inter-agent message files (~/.pokegents/messages/).
type MessageStore interface {
	// Send stores a new message in the recipient's mailbox.
	Send(from, fromName, to, toName, content string) (*Message, error)
	// GetUndelivered returns messages with delivered=false for a session.
	GetUndelivered(sessionID string) ([]Message, error)
	// MarkDelivered marks specific messages as delivered (keeps files on disk).
	MarkDelivered(msgIDs []string) error
	// Consume returns all messages and deletes their files (agent acknowledged receipt).
	Consume(sessionID string) ([]Message, error)
	// GetBudget returns the current message count for a session.
	GetBudget(sessionID string) (int, error)
	// ResetBudget resets the message count to 0.
	ResetBudget(sessionID string) error
	// GetHistory returns recent message history (for UI display).
	GetHistory() ([]Message, error)
	// AppendHistory adds a message to the history log.
	AppendHistory(msg Message) error
	// GetConnections returns unique agent pairs that have communicated.
	GetConnections() ([]Connection, error)
}

// ActivityStore manages the shared activity log (~/.pokegents/activity/).
type ActivityStore interface {
	// Append adds an entry to a project's activity log.
	Append(projectHash string, entry ActivityEntry) error
	// GetSince returns entries after a given line number for a project.
	GetSince(projectHash string, afterLine int) ([]ActivityEntry, int, error)
	// GetLastReadLine returns the last-read line number for a session.
	GetLastReadLine(projectHash, sessionID string) (int, error)
	// SetLastReadLine updates the last-read line number.
	SetLastReadLine(projectHash, sessionID string, line int) error
}

// FileEvent represents a change to a watched file.
type FileEvent struct {
	Type      string // "create", "update", "delete", "rename"
	SessionID string
	Path      string
}

// --- Shared types used across stores ---
// These will move to core/types.go in Phase 2. For now, defined here
// to avoid circular imports.

// RunningSession is the data stored in ~/.pokegents/running/*.json.
type RunningSession struct {
	Profile        string `json:"profile"`
	SessionID      string `json:"session_id"`
	PID            int    `json:"pid"`
	ClaudePID      int    `json:"claude_pid"`
	TTY            string `json:"tty"`
	DisplayName    string `json:"display_name"`
	CCDSessionID   string `json:"ccd_session_id,omitempty"`
	ITermSessionID string `json:"iterm_session_id,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
}

// StatusFile is the data stored in ~/.pokegents/status/*.json.
type StatusFile struct {
	SessionID     string   `json:"session_id"`
	State         string   `json:"state"`
	Detail        string   `json:"detail"`
	CWD           string   `json:"cwd"`
	Timestamp     string   `json:"timestamp"`
	BusySince     string   `json:"busy_since,omitempty"`
	LastSummary   string   `json:"last_summary"`
	LastTrace     string   `json:"last_trace"`
	UserPrompt    string   `json:"user_prompt"`
	RecentActions []string `json:"recent_actions,omitempty"`
}

// Profile represents a pokegent profile configuration.
type Profile struct {
	Name         string `json:"name"`
	Title        string `json:"title"`
	Emoji        string `json:"emoji"`
	Color        [3]int `json:"color"`
	CWD          string `json:"cwd"`
	SystemPrompt string `json:"system_prompt,omitempty"`
	ITermProfile string `json:"iterm2_profile,omitempty"`
}

// AppConfig is the global config from ~/.pokegents/config.json.
type AppConfig struct {
	Port                int    `json:"port"`
	DefaultProfile      string `json:"default_profile"`
	SkipPermissions     bool   `json:"skip_permissions"`
	ITermRestoreProfile string `json:"iterm2_restore_profile"`
}

// Message represents a message between agents.
type Message struct {
	ID        string `json:"id"`
	From      string `json:"from"`
	FromName  string `json:"from_name"`
	To        string `json:"to"`
	ToName    string `json:"to_name"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
	Delivered bool   `json:"delivered"`
}

// Connection represents a communication link between two agents.
type Connection struct {
	AgentA       string `json:"agent_a"`
	AgentB       string `json:"agent_b"`
	AgentAName   string `json:"agent_a_name"`
	AgentBName   string `json:"agent_b_name"`
	MessageCount int    `json:"message_count"`
	LastMessage  string `json:"last_message"`
}

// ActivityEntry is a single line in the activity log.
type ActivityEntry struct {
	Timestamp string `json:"timestamp"`
	SessionID string `json:"session_id"`
	AgentName string `json:"agent_name"`
	Files     string `json:"files"`
	Summary   string `json:"summary"`
	Raw       string `json:"-"` // original log line
}
