package server

// Profile represents a pokegents profile configuration.
type Profile struct {
	Name         string `json:"name"`
	Title        string `json:"title"`
	Emoji        string `json:"emoji"`
	Color        [3]int `json:"color"`
	CWD          string `json:"cwd"`
	SystemPrompt string `json:"system_prompt,omitempty"`
	ITermProfile string `json:"iterm2_profile,omitempty"`
}

// RunningSession is the data stored in ~/.ccsession/running/*.json.
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

// StatusFile is the data stored in ~/.ccsession/status/*.json.
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

// AgentState is the merged view sent to the frontend.
type AgentState struct {
	SessionID    string `json:"session_id"`
	CCDSessionID string `json:"ccd_session_id,omitempty"`
	ProfileName  string `json:"profile_name"`
	DisplayName  string `json:"display_name"`
	Emoji        string `json:"emoji"`
	Color        [3]int `json:"color"`
	State       string `json:"state"`
	Detail      string `json:"detail"`
	CWD         string `json:"cwd"`
	LastSummary string `json:"last_summary"`
	LastTrace     string   `json:"last_trace"`
	UserPrompt    string   `json:"user_prompt"`
	RecentActions []string       `json:"recent_actions,omitempty"`
	ActivityFeed  []ActivityItem `json:"activity_feed,omitempty"`
	ContextTokens int            `json:"context_tokens"`
	ContextWindow int    `json:"context_window"`
	LastUpdated   string `json:"last_updated"`
	BusySince     string `json:"busy_since,omitempty"`
	PID            int    `json:"pid"`
	TTY            string `json:"tty"`
	ITermSessionID string `json:"iterm_session_id,omitempty"`
	IsAlive        bool   `json:"is_alive"`
	DurationSec    int    `json:"duration_sec"`
	CreatedAt      string `json:"created_at,omitempty"`
}

// ActivityItem is a single entry in the agent's activity feed.
type ActivityItem struct {
	Time string `json:"time"` // HH:MM:SS
	Type string `json:"type"` // "tool", "text", "thinking"
	Text string `json:"text"`
}

// HookEvent is the JSON posted by Claude Code hooks.
type HookEvent struct {
	SessionID            string `json:"session_id"`
	HookEventName        string `json:"hook_event_name"`
	ToolName             string `json:"tool_name,omitempty"`
	ToolInput            any    `json:"tool_input,omitempty"`
	CWD                  string `json:"cwd"`
	LastAssistantMessage string `json:"last_assistant_message,omitempty"`
	NotificationType     string `json:"notification_type,omitempty"`
	TranscriptPath       string `json:"transcript_path,omitempty"`
	Prompt               string `json:"prompt,omitempty"`
}

// SearchResult is returned by the search API.
type SearchResult struct {
	SessionID      string `json:"session_id"`
	ProjectDir     string `json:"project_dir"`
	CustomTitle    string `json:"custom_title"`
	ProfileName    string `json:"profile_name"`
	Snippet        string `json:"snippet"`
	MessageType    string `json:"message_type"`
	Timestamp      string `json:"timestamp"`
	CWD            string `json:"cwd"`
	GitBranch      string `json:"git_branch"`
	SpriteOverride string `json:"sprite_override,omitempty"`
}

// SearchResponse wraps search results with total count.
type SearchResponse struct {
	Results []SearchResult `json:"results"`
	Total   int            `json:"total"`
}
