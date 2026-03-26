package server

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

	_ "github.com/mattn/go-sqlite3"
)

// SearchIndex manages the SQLite FTS5 search index over session JSONL files.
type SearchIndex struct {
	mu               sync.Mutex
	db               *sql.DB
	claudeProjectDir string
	state            *StateManager
	done             chan struct{}
}

func NewSearchIndex(dbPath, claudeProjectDir string, state *StateManager) (*SearchIndex, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return nil, err
	}

	si := &SearchIndex{
		db:               db,
		claudeProjectDir: claudeProjectDir,
		state:            state,
		done:             make(chan struct{}),
	}

	if err := si.createTables(); err != nil {
		db.Close()
		return nil, err
	}

	return si, nil
}

func (si *SearchIndex) createTables() error {
	_, err := si.db.Exec(`
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
	return err
}

// BuildIndex scans all JSONL files and indexes new/modified ones.
func (si *SearchIndex) BuildIndex() {
	si.mu.Lock()
	defer si.mu.Unlock()

	entries, err := os.ReadDir(si.claudeProjectDir)
	if err != nil {
		log.Printf("search: cannot read projects dir: %v", err)
		return
	}

	indexed := 0
	for _, dirEntry := range entries {
		if !dirEntry.IsDir() {
			continue
		}
		projDir := filepath.Join(si.claudeProjectDir, dirEntry.Name())
		files, err := filepath.Glob(filepath.Join(projDir, "*.jsonl"))
		if err != nil {
			continue
		}
		for _, f := range files {
			if si.indexFileIfNeeded(f, dirEntry.Name()) {
				indexed++
			}
		}
	}

	if indexed > 0 {
		log.Printf("search: indexed %d session files", indexed)
	}
}

func (si *SearchIndex) indexFileIfNeeded(path, projectDir string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	modTime := float64(info.ModTime().UnixMilli()) / 1000.0
	sessionID := strings.TrimSuffix(filepath.Base(path), ".jsonl")

	// Check if already indexed with same mtime
	var existingMod float64
	err = si.db.QueryRow("SELECT last_modified FROM session_meta WHERE session_id = ?", sessionID).Scan(&existingMod)
	if err == nil && existingMod >= modTime {
		return false
	}

	// Parse the JSONL
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

	// Match profile
	profileName := ""
	if cwd != "" {
		profileName, _, _ = si.state.MatchProfile(cwd)
	}

	// Upsert into meta table
	si.db.Exec(`DELETE FROM session_meta WHERE session_id = ?`, sessionID)
	si.db.Exec(`DELETE FROM sessions_fts WHERE session_id = ?`, sessionID)

	si.db.Exec(`INSERT INTO session_meta (session_id, project_dir, custom_title, first_user_message, last_modified, profile_name, cwd, git_branch)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, projectDir, customTitle, firstUserMessage, modTime, profileName, cwd, gitBranch)

	si.db.Exec(`INSERT INTO sessions_fts (session_id, project_dir, custom_title, user_messages, assistant_messages)
		VALUES (?, ?, ?, ?, ?)`,
		sessionID, projectDir, customTitle, userMessages.String(), assistantMsgs.String())

	return true
}

// Search performs a full-text search and returns results.
func (si *SearchIndex) Search(query string, limit, offset int) ([]SearchResult, int, error) {
	si.mu.Lock()
	defer si.mu.Unlock()

	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	// Build FTS5 query — add * for prefix matching if not quoted
	ftsQuery := query
	if !strings.Contains(query, `"`) {
		words := strings.Fields(query)
		for i, w := range words {
			words[i] = w + "*"
		}
		ftsQuery = strings.Join(words, " ")
	}

	// Count total results
	var total int
	err := si.db.QueryRow(`SELECT COUNT(*) FROM sessions_fts WHERE sessions_fts MATCH ?`, ftsQuery).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("search count failed: %w", err)
	}

	// Fetch results with snippets
	rows, err := si.db.Query(`
		SELECT
			f.session_id, f.project_dir,
			COALESCE(m.custom_title, ''),
			COALESCE(m.profile_name, ''),
			snippet(sessions_fts, 3, '<mark>', '</mark>', '...', 40) as snippet,
			COALESCE(m.cwd, ''),
			COALESCE(m.git_branch, ''),
			rank
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
		if err := rows.Scan(&r.SessionID, &r.ProjectDir, &r.CustomTitle, &r.ProfileName, &r.Snippet, &r.CWD, &r.GitBranch, &rank); err != nil {
			continue
		}
		results = append(results, r)
	}

	return results, total, nil
}

// RecentSessions returns the most recently modified sessions.
func (si *SearchIndex) RecentSessions(limit int) ([]SearchResult, error) {
	si.mu.Lock()
	defer si.mu.Unlock()

	if limit <= 0 {
		limit = 20
	}

	rows, err := si.db.Query(`
		SELECT session_id, project_dir, COALESCE(custom_title, ''),
			   COALESCE(profile_name, ''), COALESCE(first_user_message, ''),
			   COALESCE(cwd, ''), COALESCE(git_branch, '')
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
		if err := rows.Scan(&r.SessionID, &r.ProjectDir, &r.CustomTitle, &r.ProfileName, &r.Snippet, &r.CWD, &r.GitBranch); err != nil {
			continue
		}
		results = append(results, r)
	}
	return results, nil
}

// StartBackgroundIndexer re-indexes every interval.
func (si *SearchIndex) StartBackgroundIndexer(interval time.Duration) {
	go func() {
		// Initial index
		si.BuildIndex()

		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-si.done:
				return
			case <-ticker.C:
				si.BuildIndex()
			}
		}
	}()
}

// Close shuts down the search index.
func (si *SearchIndex) Close() {
	close(si.done)
	if si.db != nil {
		si.db.Close()
	}
}

// GetProfileName looks up the profile name for a session from the search index.
func (si *SearchIndex) GetProfileName(sessionID string) string {
	si.mu.Lock()
	defer si.mu.Unlock()
	var pn string
	si.db.QueryRow("SELECT profile_name FROM session_meta WHERE session_id = ?", sessionID).Scan(&pn)
	return pn
}

// UpdateCustomTitle updates the display name in the search index.
func (si *SearchIndex) UpdateCustomTitle(sessionID, title string) {
	si.mu.Lock()
	defer si.mu.Unlock()
	si.db.Exec("UPDATE session_meta SET custom_title = ? WHERE session_id = ?", title, sessionID)
	si.db.Exec("UPDATE sessions_fts SET custom_title = ? WHERE session_id = ?", title, sessionID)
}

// --- message text extraction ---

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
		blockType, _ := m["type"].(string)
		// Skip thinking and tool_use blocks
		if blockType == "text" {
			if t, ok := m["text"].(string); ok {
				texts = append(texts, t)
			}
		}
	}
	return strings.Join(texts, "\n")
}

