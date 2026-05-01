package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// QueuedPrompt is a single prompt waiting to be sent to the agent. The queue
// holds prompts the user typed while the agent was busy; they're drained
// FIFO when the agent becomes idle. Persisted to disk so prompts survive
// page refresh / dashboard restart.
type QueuedPrompt struct {
	Text   string `json:"text"`
	Nonce  string `json:"nonce"`
	SentAt int64  `json:"sent_at"` // unix ms
}

// PromptQueue is a thread-safe, file-backed FIFO for queued prompts.
// Each chat-mode pokegent gets its own queue at ~/.pokegents/queues/{pgid}.json.
type PromptQueue struct {
	mu    sync.Mutex
	items []QueuedPrompt
	path  string
}

// NewPromptQueue creates (or loads) a queue for the given pokegent_id.
func NewPromptQueue(pgid string) *PromptQueue {
	dir := filepath.Join(os.Getenv("HOME"), ".pokegents", "queues")
	os.MkdirAll(dir, 0755)
	q := &PromptQueue{
		path: filepath.Join(dir, pgid+".json"),
	}
	q.load()
	return q
}

// Enqueue appends a prompt to the back of the queue and persists to disk.
func (q *PromptQueue) Enqueue(text, nonce string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items = append(q.items, QueuedPrompt{
		Text:   text,
		Nonce:  nonce,
		SentAt: time.Now().UnixMilli(),
	})
	q.persist()
}

// Dequeue removes and returns the front item, or (zero, false) if empty.
func (q *PromptQueue) Dequeue() (QueuedPrompt, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return QueuedPrompt{}, false
	}
	item := q.items[0]
	q.items = q.items[1:]
	q.persist()
	return item, true
}

// Pending returns a snapshot of all queued prompts (oldest first).
func (q *PromptQueue) Pending() []QueuedPrompt {
	q.mu.Lock()
	defer q.mu.Unlock()
	result := make([]QueuedPrompt, len(q.items))
	copy(result, q.items)
	return result
}

// Len returns the number of queued items.
func (q *PromptQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

func (q *PromptQueue) persist() {
	if q.path == "" {
		return
	}
	data, _ := json.MarshalIndent(q.items, "", "  ")
	tmp := q.path + ".tmp"
	_ = os.WriteFile(tmp, data, 0644)
	_ = os.Rename(tmp, q.path)
}

func (q *PromptQueue) load() {
	data, err := os.ReadFile(q.path)
	if err != nil {
		return
	}
	json.Unmarshal(data, &q.items)
}
