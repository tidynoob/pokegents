// Package services contains business-logic services that sit between
// HTTP handlers and the store layer.
package services

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"pokegents/dashboard/server/store"

	_ "github.com/mattn/go-sqlite3"
)

// ProfileMatcher can resolve a CWD to a profile name.
type ProfileMatcher interface {
	MatchProfile(cwd string) (name string)
}

// ProfileMatcherFunc adapts a plain function to the ProfileMatcher interface.
type ProfileMatcherFunc func(cwd string) string

func (f ProfileMatcherFunc) MatchProfile(cwd string) string { return f(cwd) }

// SearchResult is returned by Search and RecentSessions.
type SearchResult struct {
	SessionID   string `json:"session_id"`
	ProjectDir  string `json:"project_dir"`
	CustomTitle string `json:"custom_title"`
	ProfileName string `json:"profile_name"`
	Role        string `json:"role,omitempty"`
	Project     string `json:"project,omitempty"`
	Snippet     string `json:"snippet"`
	CWD         string `json:"cwd"`
	GitBranch   string `json:"git_branch"`
}

// SearchResponse wraps search results with total count.
type SearchResponse struct {
	Results []SearchResult `json:"results"`
	Total   int            `json:"total"`
}

// SearchService manages the SQLite FTS5 search index over session transcripts.
type SearchService struct {
	mu               sync.Mutex
	db               *sql.DB
	claudeProjectDir string
	profiles         store.ProfileStore
	profileMatcher   ProfileMatcher
	done             chan struct{}
}

// NewSearchService creates a search service backed by SQLite FTS5.
func NewSearchService(dbPath, claudeProjectDir string, profiles store.ProfileStore, matcher ProfileMatcher) (*SearchService, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return nil, err
	}

	ss := &SearchService{
		db:               db,
		claudeProjectDir: claudeProjectDir,
		profiles:         profiles,
		profileMatcher:   matcher,
		done:             make(chan struct{}),
	}

	if err := ss.createTables(); err != nil {
		db.Close()
		return nil, err
	}

	return ss, nil
}

func (ss *SearchService) createTables() error {
	_, err := ss.db.Exec(`
		CREATE TABLE IF NOT EXISTS session_meta (
			session_id TEXT PRIMARY KEY,
			project_dir TEXT,
			custom_title TEXT,
			first_user_message TEXT,
			last_modified REAL,
			profile_name TEXT,
			cwd TEXT,
			git_branch TEXT
		);

		CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
			session_id UNINDEXED,
			project_dir UNINDEXED,
			custom_title,
			user_messages,
			assistant_messages,
			tokenize='porter unicode61'
		);
	`)
	if err != nil {
		return err
	}
	// Migrate: add columns added after initial schema (ignore error if already exists)
	ss.db.Exec(`ALTER TABLE session_meta ADD COLUMN last_user_message TEXT`)
	ss.db.Exec(`ALTER TABLE session_meta ADD COLUMN last_assistant_message TEXT`)
	return nil
}

// BuildIndex scans all JSONL files and indexes new/modified ones.
func (ss *SearchService) BuildIndex() {
	ss.mu.Lock()
	defer ss.mu.Unlock()

	entries, err := os.ReadDir(ss.claudeProjectDir)
	if err != nil {
		log.Printf("search: cannot read projects dir: %v", err)
		return
	}

	indexed := 0
	for _, dirEntry := range entries {
		if !dirEntry.IsDir() {
			continue
		}
		projDir := filepath.Join(ss.claudeProjectDir, dirEntry.Name())
		files, err := filepath.Glob(filepath.Join(projDir, "*.jsonl"))
		if err != nil {
			continue
		}
		for _, f := range files {
			if ss.indexFileIfNeeded(f, dirEntry.Name()) {
				indexed++
			}
		}
	}

	if indexed > 0 {
		log.Printf("search: indexed %d session files", indexed)
	}
}

func (ss *SearchService) indexFileIfNeeded(path, projectDir string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	modTime := float64(info.ModTime().UnixMilli()) / 1000.0
	sessionID := strings.TrimSuffix(filepath.Base(path), ".jsonl")

	var existingMod float64
	err = ss.db.QueryRow("SELECT last_modified FROM session_meta WHERE session_id = ?", sessionID).Scan(&existingMod)
	if err == nil && existingMod >= modTime {
		return false
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}

	var (
		customTitle      string
		firstUserMessage string
		userMessages     strings.Builder
		assistantMsgs    strings.Builder
		cwd              string
		gitBranch        string
	)

	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}

		entryType, _ := entry["type"].(string)

		if cwd == "" {
			if c, ok := entry["cwd"].(string); ok {
				cwd = c
			}
		}
		if gitBranch == "" {
			if b, ok := entry["gitBranch"].(string); ok {
				gitBranch = b
			}
		}

		switch entryType {
		case "custom-title":
			if t, ok := entry["customTitle"].(string); ok {
				customTitle = t
			}
		case "user":
			text := extractMessageText(entry)
			if text != "" {
				if firstUserMessage == "" {
					firstUserMessage = truncate(text, 200)
				}
				userMessages.WriteString(text)
				userMessages.WriteString("\n")
			}
		case "assistant":
			text := extractAssistantText(entry)
			if text != "" {
				assistantMsgs.WriteString(text)
				assistantMsgs.WriteString("\n")
			}
		}
	}

	profileName := ""
	if cwd != "" && ss.profileMatcher != nil {
		profileName = ss.profileMatcher.MatchProfile(cwd)
	}

	ss.db.Exec(`DELETE FROM session_meta WHERE session_id = ?`, sessionID)
	ss.db.Exec(`DELETE FROM sessions_fts WHERE session_id = ?`, sessionID)

	ss.db.Exec(`INSERT INTO session_meta (session_id, project_dir, custom_title, first_user_message, last_modified, profile_name, cwd, git_branch)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, projectDir, customTitle, firstUserMessage, modTime, profileName, cwd, gitBranch)

	ss.db.Exec(`INSERT INTO sessions_fts (session_id, project_dir, custom_title, user_messages, assistant_messages)
		VALUES (?, ?, ?, ?, ?)`,
		sessionID, projectDir, customTitle, userMessages.String(), assistantMsgs.String())

	return true
}

// Search performs a full-text search and returns results.
func (ss *SearchService) Search(query string, limit, offset int) ([]SearchResult, int, error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()

	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	ftsQuery := query
	if !strings.Contains(query, `"`) {
		words := strings.Fields(query)
		for i, w := range words {
			words[i] = w + "*"
		}
		ftsQuery = strings.Join(words, " ")
	}

	var total int
	err := ss.db.QueryRow(`SELECT COUNT(*) FROM sessions_fts WHERE sessions_fts MATCH ?`, ftsQuery).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("search count failed: %w", err)
	}

	rows, err := ss.db.Query(`
		SELECT
			f.session_id, f.project_dir,
			COALESCE(m.custom_title, ''),
			COALESCE(m.profile_name, ''),
			snippet(sessions_fts, 3, '<mark>', '</mark>', '...', 40) as snippet,
			COALESCE(m.cwd, ''),
			COALESCE(m.git_branch, ''),
			rank,
			COALESCE(m.role, ''),
			COALESCE(m.project, '')
		FROM sessions_fts f
		LEFT JOIN session_meta m ON f.session_id = m.session_id
		WHERE sessions_fts MATCH ?
		ORDER BY rank
		LIMIT ? OFFSET ?
	`, ftsQuery, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("search query failed: %w", err)
	}
	defer rows.Close()

	var results []SearchResult
	for rows.Next() {
		var r SearchResult
		var rank float64
		if err := rows.Scan(&r.SessionID, &r.ProjectDir, &r.CustomTitle, &r.ProfileName, &r.Snippet, &r.CWD, &r.GitBranch, &rank, &r.Role, &r.Project); err != nil {
			continue
		}
		results = append(results, r)
	}

	return results, total, nil
}

// RecentSessions returns the most recently modified sessions.
func (ss *SearchService) RecentSessions(limit int) ([]SearchResult, error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()

	if limit <= 0 {
		limit = 20
	}

	rows, err := ss.db.Query(`
		SELECT session_id, project_dir, COALESCE(custom_title, ''),
			   COALESCE(profile_name, ''), COALESCE(first_user_message, ''),
			   COALESCE(cwd, ''), COALESCE(git_branch, ''),
			   COALESCE(role, ''), COALESCE(project, '')
		FROM session_meta
		ORDER BY last_modified DESC
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []SearchResult
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.SessionID, &r.ProjectDir, &r.CustomTitle, &r.ProfileName, &r.Snippet, &r.CWD, &r.GitBranch, &r.Role, &r.Project); err != nil {
			continue
		}
		results = append(results, r)
	}
	return results, nil
}

// UpdateCustomTitle updates the display name in the search index.
func (ss *SearchService) UpdateCustomTitle(sessionID, title string) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	ss.db.Exec("UPDATE session_meta SET custom_title = ? WHERE session_id = ?", title, sessionID)
	ss.db.Exec("UPDATE sessions_fts SET custom_title = ? WHERE session_id = ?", title, sessionID)
}

// GetProfileName looks up the profile name for a session.
func (ss *SearchService) GetProfileName(sessionID string) string {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	var pn string
	ss.db.QueryRow("SELECT profile_name FROM session_meta WHERE session_id = ?", sessionID).Scan(&pn)
	return pn
}

// StartBackgroundIndexer re-indexes every interval.
func (ss *SearchService) StartBackgroundIndexer(interval time.Duration) {
	go func() {
		ss.BuildIndex()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ss.done:
				return
			case <-ticker.C:
				ss.BuildIndex()
			}
		}
	}()
}

// Close shuts down the search service.
func (ss *SearchService) Close() {
	close(ss.done)
	if ss.db != nil {
		ss.db.Close()
	}
}

// --- text extraction helpers ---

func extractMessageText(entry map[string]any) string {
	msg, ok := entry["message"].(map[string]any)
	if !ok {
		return ""
	}
	content := msg["content"]
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var texts []string
		for _, block := range c {
			if m, ok := block.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					texts = append(texts, t)
				}
			}
		}
		return strings.Join(texts, "\n")
	}
	return ""
}

func extractAssistantText(entry map[string]any) string {
	msg, ok := entry["message"].(map[string]any)
	if !ok {
		return ""
	}
	content, ok := msg["content"].([]any)
	if !ok {
		return ""
	}
	var texts []string
	for _, block := range content {
		m, ok := block.(map[string]any)
		if !ok {
			continue
		}
		if blockType, _ := m["type"].(string); blockType == "text" {
			if t, ok := m["text"].(string); ok {
				texts = append(texts, t)
			}
		}
	}
	return strings.Join(texts, "\n")
}

func truncate(s string, maxLen int) string {
	r := []rune(s)
	if len(r) <= maxLen {
		return s
	}
	return string(r[:maxLen])
}
