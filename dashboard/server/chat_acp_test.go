package server

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestBuildACPPromptBlocks_NoImages — the common case: plain text becomes a
// single text content block.
func TestBuildACPPromptBlocks_NoImages(t *testing.T) {
	blocks, err := buildACPPromptBlocks("hello world")
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d (%v)", len(blocks), blocks)
	}
	got, _ := blocks[0].(map[string]any)
	if got["type"] != "text" || got["text"] != "hello world" {
		t.Errorf("unexpected text block: %+v", got)
	}
}

// TestBuildACPPromptBlocks_OnlyImage — a bare token with no surrounding
// prose should produce just an image block (no empty text padding).
func TestBuildACPPromptBlocks_OnlyImage(t *testing.T) {
	tmp := writeTempPNG(t, []byte{0x89, 0x50, 0x4E, 0x47}) // PNG magic; bytes irrelevant
	blocks, err := buildACPPromptBlocks("[Image: " + tmp + "]")
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d (%v)", len(blocks), blocks)
	}
	got, _ := blocks[0].(map[string]any)
	if got["type"] != "image" {
		t.Errorf("want image type, got %v", got["type"])
	}
	if got["mimeType"] != "image/png" {
		t.Errorf("want image/png mime, got %v", got["mimeType"])
	}
	wantData := base64.StdEncoding.EncodeToString([]byte{0x89, 0x50, 0x4E, 0x47})
	if got["data"] != wantData {
		t.Errorf("base64 mismatch: got %v", got["data"])
	}
}

// TestBuildACPPromptBlocks_TextThenImage — surrounding text gets its own
// blocks, with whitespace trimmed, and the image rides between them.
func TestBuildACPPromptBlocks_TextThenImage(t *testing.T) {
	tmp := writeTempPNG(t, []byte("png-data"))
	blocks, err := buildACPPromptBlocks("look at [Image: " + tmp + "] and tell me")
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d (%v)", len(blocks), blocks)
	}
	first, _ := blocks[0].(map[string]any)
	mid, _ := blocks[1].(map[string]any)
	last, _ := blocks[2].(map[string]any)
	if first["type"] != "text" || first["text"] != "look at" {
		t.Errorf("first: want text 'look at', got %+v", first)
	}
	if mid["type"] != "image" {
		t.Errorf("mid: want image, got %+v", mid)
	}
	if last["type"] != "text" || last["text"] != "and tell me" {
		t.Errorf("last: want text 'and tell me', got %+v", last)
	}
}

// TestBuildACPPromptBlocks_MissingFile — when an image token references a
// non-existent path, fall back to including the literal token as text so
// the agent at least sees the path; never error out.
func TestBuildACPPromptBlocks_MissingFile(t *testing.T) {
	blocks, err := buildACPPromptBlocks("hi [Image: /tmp/does-not-exist-12345.png] there")
	if err != nil {
		t.Fatal(err)
	}
	// Three blocks: "hi", literal-text-fallback, "there"
	if len(blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d", len(blocks))
	}
	mid, _ := blocks[1].(map[string]any)
	if mid["type"] != "text" {
		t.Errorf("missing-file fallback should be text, got %v", mid["type"])
	}
}

// TestMimeForImagePath — extension → mime mapping. Defends image paste
// against silent breakage when adding new image formats.
func TestMimeForImagePath(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/tmp/x.png", "image/png"},
		{"/tmp/x.PNG", "image/png"},
		{"/tmp/x.jpg", "image/jpeg"},
		{"/tmp/x.jpeg", "image/jpeg"},
		{"/tmp/x.gif", "image/gif"},
		{"/tmp/x.webp", "image/webp"},
		{"/tmp/x.bin", "application/octet-stream"},
		{"/tmp/x", "application/octet-stream"},
	}
	for _, c := range cases {
		if got := mimeForImagePath(c.in); got != c.want {
			t.Errorf("mimeForImagePath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestExtractCwdFromJSONL — first non-null cwd entry wins; pre-cwd
// metadata entries (custom-title, agent-name) are skipped.
func TestExtractCwdFromJSONL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.jsonl")
	lines := []string{
		`{"type":"custom-title","cwd":null}`,
		`{"type":"agent-name","cwd":null}`,
		`{"type":"system","cwd":"/Users/x/Projects"}`,
		`{"type":"user","cwd":"/Users/x/Projects"}`,
	}
	body := ""
	for _, l := range lines {
		body += l + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := extractCwdFromJSONL(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "/Users/x/Projects" {
		t.Errorf("got %q, want /Users/x/Projects", got)
	}
}

// TestExtractCwdFromJSONL_AllNull — when every entry has a null cwd we
// return an error so callers can refuse to launch with a bad cwd.
func TestExtractCwdFromJSONL_AllNull(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.jsonl")
	body := `{"type":"custom-title","cwd":null}` + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := extractCwdFromJSONL(path)
	if err == nil {
		t.Errorf("expected error for all-null cwds")
	}
}

// TestChatVerbLabel — known kinds map to title-case English verbs that
// match the iterm2 hooks' format. Regression here would break the
// recent_actions display in the agent card.
func TestChatVerbLabel(t *testing.T) {
	cases := []struct{ in, want string }{
		{"execute", "Bash"},
		{"read", "Read"},
		{"edit", "Edit"},
		{"search", "Grep"},
		{"fetch", "WebFetch"},
		{"think", "Think"},
		{"other", "Tool"},
		{"", ""},
		{"weirdkind", "Weirdkind"},
	}
	for _, c := range cases {
		if got := chatVerbLabel(c.in); got != c.want {
			t.Errorf("chatVerbLabel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestChatToolArgs — prefers known argv fields over locations; falls back
// to first location path; returns "" when nothing useful is present.
func TestChatToolArgs(t *testing.T) {
	loc := []struct {
		Path string `json:"path"`
	}{{Path: "/tmp/foo"}}
	cases := []struct {
		name      string
		raw       string
		locations []struct {
			Path string `json:"path"`
		}
		want string
	}{
		{"command wins", `{"command":"ls -la"}`, loc, "ls -la"},
		{"file_path next", `{"file_path":"/etc/hosts"}`, loc, "/etc/hosts"},
		{"falls back to location", `{}`, loc, "/tmp/foo"},
		{"empty everywhere", `{}`, nil, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := chatToolArgs(json.RawMessage(c.raw), c.locations)
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

// TestEffortToThinkingConfig pins the pokegents-effort → SDK-thinking-config
// mapping. Frontend writes "low/medium/high/max" into role/project configs,
// and the chat backend translates here. A regression here silently breaks
// model effort for chat agents (the wrapper just runs on SDK defaults).
func TestEffortToThinkingConfig(t *testing.T) {
	cases := []struct {
		in       string
		wantType string
		wantBudget int // 0 if not applicable
	}{
		{"low", "enabled", 4000},
		{"medium", "enabled", 10000},
		{"high", "enabled", 32000},
		{"max", "adaptive", 0},
		{"", "", 0},
		{"unknown", "", 0},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			got := effortToThinkingConfig(c.in)
			if c.wantType == "" {
				if got != nil {
					t.Errorf("effortToThinkingConfig(%q) = %+v, want nil", c.in, got)
				}
				return
			}
			if got == nil {
				t.Fatalf("effortToThinkingConfig(%q) = nil, want type=%q", c.in, c.wantType)
			}
			if got["type"] != c.wantType {
				t.Errorf("type: got %v, want %q", got["type"], c.wantType)
			}
			if c.wantBudget > 0 {
				if budget, _ := got["budgetTokens"].(int); budget != c.wantBudget {
					t.Errorf("budgetTokens: got %v, want %d", got["budgetTokens"], c.wantBudget)
				}
			}
		})
	}
}

// writeTempPNG creates a temp file with the given bytes and returns its
// path. Cleanup is automatic via t.TempDir.
func writeTempPNG(t *testing.T, data []byte) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.png")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
