package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileRunningStore(t *testing.T) {
	dir := t.TempDir()
	runDir := filepath.Join(dir, "running")
	os.MkdirAll(runDir, 0755)

	s := &FileRunningStore{dir: runDir}

	// Create
	rs := RunningSession{
		Profile:      "test",
		SessionID:    "abc-123",
		CCDSessionID: "def-456",
		DisplayName:  "Test Agent",
		PID:          1234,
		TTY:          "/dev/ttys001",
	}
	if err := s.Create(rs); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Get
	got, err := s.Get("abc-123")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.DisplayName != "Test Agent" {
		t.Errorf("DisplayName = %q, want %q", got.DisplayName, "Test Agent")
	}

	// GetByCCDSessionID
	got, err = s.GetByCCDSessionID("def-456")
	if err != nil {
		t.Fatalf("GetByCCDSessionID: %v", err)
	}
	if got.SessionID != "abc-123" {
		t.Errorf("SessionID = %q, want %q", got.SessionID, "abc-123")
	}

	// Update
	if err := s.Update("abc-123", func(rs *RunningSession) {
		rs.DisplayName = "Renamed Agent"
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	got, _ = s.Get("abc-123")
	if got.DisplayName != "Renamed Agent" {
		t.Errorf("after Update, DisplayName = %q, want %q", got.DisplayName, "Renamed Agent")
	}

	// List
	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("List len = %d, want 1", len(list))
	}

	// Delete
	if err := s.Delete("abc-123"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	list, _ = s.List()
	if len(list) != 0 {
		t.Errorf("after Delete, List len = %d, want 0", len(list))
	}
}

func TestFileStatusStore(t *testing.T) {
	dir := t.TempDir()
	statusDir := filepath.Join(dir, "status")
	os.MkdirAll(statusDir, 0755)

	s := &FileStatusStore{dir: statusDir}

	sf := StatusFile{SessionID: "test-1", State: "busy", Detail: "processing"}
	if err := s.Upsert(sf); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	got, err := s.Get("test-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.State != "busy" {
		t.Errorf("State = %q, want %q", got.State, "busy")
	}

	// Update
	sf.State = "idle"
	s.Upsert(sf)
	got, _ = s.Get("test-1")
	if got.State != "idle" {
		t.Errorf("after Upsert, State = %q, want %q", got.State, "idle")
	}

	// Delete
	s.Delete("test-1")
	_, err = s.Get("test-1")
	if err == nil {
		t.Error("expected error after Delete")
	}
}

func TestFileMessageStore(t *testing.T) {
	dir := t.TempDir()
	msgDir := filepath.Join(dir, "messages")
	os.MkdirAll(msgDir, 0755)

	s := &FileMessageStore{dir: msgDir, dataDir: dir}

	// Send
	msg, err := s.Send("agent-a", "Agent A", "agent-b", "Agent B", "hello")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if msg.Content != "hello" {
		t.Errorf("Content = %q, want %q", msg.Content, "hello")
	}

	// GetUndelivered
	undelivered, _ := s.GetUndelivered("agent-b")
	if len(undelivered) != 1 {
		t.Fatalf("GetUndelivered len = %d, want 1", len(undelivered))
	}

	// MarkDelivered
	s.MarkDelivered([]string{msg.ID})
	undelivered, _ = s.GetUndelivered("agent-b")
	if len(undelivered) != 0 {
		t.Errorf("after MarkDelivered, GetUndelivered len = %d, want 0", len(undelivered))
	}

	// Consume (deletes files)
	s.Send("agent-a", "Agent A", "agent-b", "Agent B", "second msg")
	consumed, _ := s.Consume("agent-b")
	if len(consumed) < 1 {
		t.Error("Consume should return messages")
	}

	// Budget
	s.ResetBudget("agent-a")
	budget, _ := s.GetBudget("agent-a")
	if budget != 0 {
		t.Errorf("budget = %d, want 0", budget)
	}
}

func TestFileConfigStore(t *testing.T) {
	dir := t.TempDir()
	s := &FileConfigStore{path: filepath.Join(dir, "config.json")}

	// Missing file → defaults
	cfg, err := s.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if cfg.Port != 7834 {
		t.Errorf("Port = %d, want 7834", cfg.Port)
	}
	if cfg.DefaultProfile != "personal" {
		t.Errorf("DefaultProfile = %q, want %q", cfg.DefaultProfile, "personal")
	}

	// With file
	os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"port": 9999}`), 0644)
	cfg, _ = s.Get()
	if cfg.Port != 9999 {
		t.Errorf("Port = %d, want 9999", cfg.Port)
	}
	// Unset fields keep defaults
	if cfg.DefaultProfile != "personal" {
		t.Errorf("DefaultProfile = %q, want %q", cfg.DefaultProfile, "personal")
	}
}
