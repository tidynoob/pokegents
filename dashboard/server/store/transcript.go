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
