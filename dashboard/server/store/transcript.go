package store

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// TranscriptReader provides read access to Claude Code JSONL transcript files.
type TranscriptReader struct {
	claudeProjectDir string
}

// NewTranscriptReader creates a reader for transcripts in the given Claude projects dir.
func NewTranscriptReader(claudeProjectDir string) *TranscriptReader {
	return &TranscriptReader{claudeProjectDir: claudeProjectDir}
}

// FindPath locates the transcript JSONL file for a session ID.
func (tr *TranscriptReader) FindPath(sessionID string) string {
	entries, err := os.ReadDir(tr.claudeProjectDir)
	if err != nil {
		return ""
	}
	for _, d := range entries {
		if !d.IsDir() {
			continue
		}
		path := filepath.Join(tr.claudeProjectDir, d.Name(), sessionID+".jsonl")
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

// ContextUsage holds token counts extracted from a transcript.
type ContextUsage struct {
	Tokens int
	Window int
}

// ExtractContextUsage reads the last assistant message's usage from the transcript.
func (tr *TranscriptReader) ExtractContextUsage(path string) ContextUsage {
	if path == "" {
		return ContextUsage{}
	}
	data := tr.readTail(path, 256*1024)
	if data == nil {
		return ContextUsage{}
	}

	var lastTokens int
	var model string
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry["type"] != "assistant" {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		if m, ok := msg["model"].(string); ok && m != "" {
			model = m
		}
		usage, ok := msg["usage"].(map[string]any)
		if !ok {
			continue
		}
		total := 0
		if v, ok := usage["input_tokens"].(float64); ok {
			total += int(v)
		}
		if v, ok := usage["cache_creation_input_tokens"].(float64); ok {
			total += int(v)
		}
		if v, ok := usage["cache_read_input_tokens"].(float64); ok {
			total += int(v)
		}
		if total > 0 {
			lastTokens = total
		}
	}

	window := 200000
	if strings.Contains(model, "opus") {
		window = 1000000
	}

	return ContextUsage{Tokens: lastTokens, Window: window}
}

// ExtractTrace reads the tail of a transcript and returns the last assistant
// text block (the live thinking/output trace).
func (tr *TranscriptReader) ExtractTrace(path string) string {
	if path == "" {
		return ""
	}
	data := tr.readTail(path, 32*1024)
	if data == nil {
		return ""
	}

	lastText := ""
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry["type"] != "assistant" {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		content, ok := msg["content"].([]any)
		if !ok {
			continue
		}
		for _, block := range content {
			m, ok := block.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "text" {
				if t, ok := m["text"].(string); ok && t != "" {
					lastText = t
				}
			}
		}
	}

	if len(lastText) > 200 {
		lastText = lastText[len(lastText)-200:]
	}
	return lastText
}

// ExtractLastUserPrompt reads the transcript and returns the last user message.
func (tr *TranscriptReader) ExtractLastUserPrompt(path string) string {
	if path == "" {
		return ""
	}
	data := tr.readTail(path, 64*1024)
	if data == nil {
		return ""
	}

	lastPrompt := ""
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry["type"] != "user" {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		switch c := msg["content"].(type) {
		case string:
			if c != "" {
				lastPrompt = c
			}
		case []any:
			for _, block := range c {
				if m, ok := block.(map[string]any); ok {
					if t, ok := m["text"].(string); ok && t != "" {
						lastPrompt = t
					}
				}
			}
		}
	}

	r := []rune(lastPrompt)
	if len(r) > 200 {
		return string(r[:200])
	}
	return lastPrompt
}

// TranscriptEntry is a parsed conversation entry for the chat panel.
type TranscriptEntry struct {
	UUID      string            `json:"uuid"`
	Type      string            `json:"type"` // "user", "assistant", "tool_result", "system"
	Timestamp string            `json:"timestamp"`
	Content   string            `json:"content,omitempty"`   // for user messages (plain text)
	Blocks    []ContentBlock    `json:"blocks,omitempty"`    // for assistant messages
	ToolUseID string            `json:"tool_use_id,omitempty"` // for tool_result
	Truncated bool              `json:"truncated,omitempty"`
	FullSize  int               `json:"full_size,omitempty"`
	Model     string            `json:"model,omitempty"`
	Tokens    *TokenInfo        `json:"tokens,omitempty"`
}

// ContentBlock is a single block within an assistant message.
type ContentBlock struct {
	Type  string `json:"type"` // "text", "thinking", "tool_use"
	Text  string `json:"text,omitempty"`
	Name  string `json:"name,omitempty"`  // tool name
	Input string `json:"input,omitempty"` // tool input summary (first 200 chars of JSON)
}

// TokenInfo holds token counts for an assistant message.
type TokenInfo struct {
	Input       int `json:"input"`
	Output      int `json:"output"`
	CacheRead   int `json:"cache_read,omitempty"`
	CacheCreate int `json:"cache_create,omitempty"`
}

// TranscriptPage is the paginated response for the chat panel.
type TranscriptPage struct {
	Entries []TranscriptEntry `json:"entries"`
	HasMore bool              `json:"has_more"`
}

// ParseTranscript reads a transcript file and returns conversation entries.
// tail: number of entries from the end (0 = all). afterUUID: only return entries after this UUID.
func (tr *TranscriptReader) ParseTranscript(path string, tail int, afterUUID string) TranscriptPage {
	if path == "" {
		return TranscriptPage{}
	}

	// For tail mode, read more data from the end; for after mode, read more broadly
	readSize := int64(512 * 1024)
	if tail > 200 || afterUUID != "" {
		readSize = 2 * 1024 * 1024 // 2MB for large requests
	}

	data := tr.readTail(path, readSize)
	if data == nil {
		return TranscriptPage{}
	}

	var entries []TranscriptEntry
	foundAfter := afterUUID == "" // if no afterUUID, include everything

	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var raw map[string]any
		if json.Unmarshal([]byte(line), &raw) != nil {
			continue
		}

		entryType, _ := raw["type"].(string)
		uuid, _ := raw["uuid"].(string)
		timestamp, _ := raw["timestamp"].(string)

		// Skip until we find the afterUUID marker
		if !foundAfter {
			if uuid == afterUUID {
				foundAfter = true
			}
			continue
		}

		switch entryType {
		case "user":
			entry := tr.parseUserEntry(raw, uuid, timestamp)
			if entry != nil {
				entries = append(entries, *entry)
			}
		case "assistant":
			entry := tr.parseAssistantEntry(raw, uuid, timestamp)
			if entry != nil {
				entries = append(entries, *entry)
			}
		case "system":
			// Only include hook summaries with systemMessage content
			if subtype, _ := raw["subtype"].(string); subtype == "stop_hook_summary" {
				continue // skip hook internals
			}
			// Include system messages that have useful content
		default:
			continue // skip progress, file-history-snapshot, etc.
		}
	}

	// Apply tail limit
	hasMore := false
	if tail > 0 && len(entries) > tail {
		entries = entries[len(entries)-tail:]
		hasMore = true
	}

	return TranscriptPage{Entries: entries, HasMore: hasMore}
}

func (tr *TranscriptReader) parseUserEntry(raw map[string]any, uuid, timestamp string) *TranscriptEntry {
	msg, ok := raw["message"].(map[string]any)
	if !ok {
		return nil
	}

	entry := &TranscriptEntry{
		UUID:      uuid,
		Type:      "user",
		Timestamp: timestamp,
	}

	switch c := msg["content"].(type) {
	case string:
		entry.Content = c
	case []any:
		// Could be tool_result blocks or text blocks
		var texts []string
		for _, block := range c {
			m, ok := block.(map[string]any)
			if !ok {
				continue
			}
			blockType, _ := m["type"].(string)
			if blockType == "tool_result" {
				toolUseID, _ := m["tool_use_id"].(string)
				content := ""
				if s, ok := m["content"].(string); ok {
					content = s
				}
				truncated := len(content) > 2000
				fullSize := len(content)
				if truncated {
					content = content[:2000]
				}
				entries := &TranscriptEntry{
					UUID:      uuid + "-tr-" + toolUseID,
					Type:      "tool_result",
					Timestamp: timestamp,
					Content:   content,
					ToolUseID: toolUseID,
					Truncated: truncated,
					FullSize:  fullSize,
				}
				// Return tool_result as a separate entry — caller collects both
				_ = entries // handled below
			} else if blockType == "text" {
				if t, ok := m["text"].(string); ok {
					texts = append(texts, t)
				}
			}
		}
		if len(texts) > 0 {
			entry.Content = strings.Join(texts, "\n")
		} else {
			// All tool_results, no user text — skip
			return nil
		}
	}

	if entry.Content == "" {
		return nil
	}
	return entry
}

func (tr *TranscriptReader) parseAssistantEntry(raw map[string]any, uuid, timestamp string) *TranscriptEntry {
	msg, ok := raw["message"].(map[string]any)
	if !ok {
		return nil
	}

	entry := &TranscriptEntry{
		UUID:      uuid,
		Type:      "assistant",
		Timestamp: timestamp,
	}

	if m, ok := msg["model"].(string); ok {
		entry.Model = m
	}

	// Parse usage
	if usage, ok := msg["usage"].(map[string]any); ok {
		tokens := &TokenInfo{}
		if v, ok := usage["input_tokens"].(float64); ok {
			tokens.Input = int(v)
		}
		if v, ok := usage["output_tokens"].(float64); ok {
			tokens.Output = int(v)
		}
		if v, ok := usage["cache_read_input_tokens"].(float64); ok {
			tokens.CacheRead = int(v)
		}
		if v, ok := usage["cache_creation_input_tokens"].(float64); ok {
			tokens.CacheCreate = int(v)
		}
		if tokens.Input > 0 || tokens.Output > 0 {
			entry.Tokens = tokens
		}
	}

	// Parse content blocks
	content, ok := msg["content"].([]any)
	if !ok {
		return nil
	}

	for _, block := range content {
		m, ok := block.(map[string]any)
		if !ok {
			continue
		}
		blockType, _ := m["type"].(string)
		switch blockType {
		case "text":
			if t, ok := m["text"].(string); ok && t != "" {
				entry.Blocks = append(entry.Blocks, ContentBlock{Type: "text", Text: t})
			}
		case "thinking":
			if t, ok := m["thinking"].(string); ok && t != "" {
				entry.Blocks = append(entry.Blocks, ContentBlock{Type: "thinking", Text: t})
			}
		case "tool_use":
			name, _ := m["name"].(string)
			inputSummary := ""
			if input, ok := m["input"].(map[string]any); ok {
				j, _ := json.Marshal(input)
				inputSummary = string(j)
				if len(inputSummary) > 200 {
					inputSummary = inputSummary[:200] + "..."
				}
			}
			entry.Blocks = append(entry.Blocks, ContentBlock{Type: "tool_use", Name: name, Input: inputSummary})
		}
	}

	if len(entry.Blocks) == 0 {
		return nil
	}
	return entry
}

// readTail reads the last n bytes of a file.
func (tr *TranscriptReader) readTail(path string, n int64) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil
	}
	offset := info.Size() - n
	if offset < 0 {
		offset = 0
	}
	f.Seek(offset, 0)

	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	return data
}
