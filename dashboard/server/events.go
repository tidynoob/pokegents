package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// SSEEvent is a single server-sent event.
type SSEEvent struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// EventBus manages SSE client connections and broadcasts.
type EventBus struct {
	mu      sync.RWMutex
	clients map[chan SSEEvent]struct{}
}

func NewEventBus() *EventBus {
	return &EventBus{
		clients: make(map[chan SSEEvent]struct{}),
	}
}

// Subscribe adds a new SSE client. Returns a channel and a cleanup function.
func (eb *EventBus) Subscribe() (chan SSEEvent, func()) {
	ch := make(chan SSEEvent, 64)
	eb.mu.Lock()
	eb.clients[ch] = struct{}{}
	eb.mu.Unlock()

	cleanup := func() {
		eb.mu.Lock()
		delete(eb.clients, ch)
		eb.mu.Unlock()
		close(ch)
	}
	return ch, cleanup
}

// Publish sends an event to all connected SSE clients.
func (eb *EventBus) Publish(eventType string, data any) {
	evt := SSEEvent{Type: eventType, Data: data}
	eb.mu.RLock()
	defer eb.mu.RUnlock()

	for ch := range eb.clients {
		select {
		case ch <- evt:
		default:
			// Client too slow, drop event
		}
	}
}

// ServeSSE is an HTTP handler that streams server-sent events.
func (eb *EventBus) ServeSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	ch, cleanup := eb.Subscribe()
	defer cleanup()

	// Send initial keepalive
	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	ctx := r.Context()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			// SSE comment keeps the connection alive through proxies/browsers
			fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()
		case evt, ok := <-ch:
			if !ok {
				return
			}
			data, err := json.Marshal(evt.Data)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Type, data)
			flusher.Flush()
		}
	}
}
