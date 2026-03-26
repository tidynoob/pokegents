package server

import (
	"log"
	"path/filepath"
	"strings"

	"github.com/fsnotify/fsnotify"
)

// Watcher monitors status/ and running/ directories for changes.
type Watcher struct {
	state    *StateManager
	eventBus *EventBus
	notifier *Notifier
	watcher  *fsnotify.Watcher
	done     chan struct{}
}

func NewWatcher(state *StateManager, eventBus *EventBus, notifier *Notifier) *Watcher {
	return &Watcher{
		state:    state,
		eventBus: eventBus,
		notifier: notifier,
		done:     make(chan struct{}),
	}
}

// Start begins watching the status and running directories.
func (w *Watcher) Start() error {
	var err error
	w.watcher, err = fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	statusDir := filepath.Join(w.state.ccdData, "status")
	runningDir := filepath.Join(w.state.ccdData, "running")

	if err := w.watcher.Add(statusDir); err != nil {
		log.Printf("watcher: cannot watch %s: %v", statusDir, err)
	}
	if err := w.watcher.Add(runningDir); err != nil {
		log.Printf("watcher: cannot watch %s: %v", runningDir, err)
	}

	go w.loop()
	return nil
}

// Stop shuts down the watcher.
func (w *Watcher) Stop() {
	close(w.done)
	if w.watcher != nil {
		w.watcher.Close()
	}
}

func (w *Watcher) loop() {
	for {
		select {
		case <-w.done:
			return
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			if !strings.HasSuffix(event.Name, ".json") {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
				continue
			}

			dir := filepath.Base(filepath.Dir(event.Name))
			switch dir {
			case "status":
				w.state.ReloadStatus(event.Name)
			case "running":
				w.state.ReloadRunning()
			}

			// Broadcast updated state
			agents := w.state.GetAgents()
			w.eventBus.Publish("state_update", agents)

		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("watcher error: %v", err)
		}
	}
}
