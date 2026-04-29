package server

// One-time mailbox migration: moves message dirs from
// `~/.pokegents/messages/{ccd_session_id}/` to `~/.pokegents/messages/{pokegent_id}/`.
// Mailboxes are now keyed by pokegent_id (the abstraction-layer identifier);
// ccd_session_id is iterm2-adapter-internal and shouldn't appear in routing.
//
// Safe to re-run: skips dirs already at their pokegent_id, merges into
// existing pokegent_id dirs file-by-file (auto-renaming on collision), and
// leaves orphan dirs (no matching running file) alone.
//
// Once the migration has run cleanly across the fleet, this whole file can
// be deleted in a follow-up release. Tracking deletion in the spec.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func migrateMailboxesToPokegentID(dataDir string) {
	runningDir := filepath.Join(dataDir, "running")
	messagesDir := filepath.Join(dataDir, "messages")

	if _, err := os.Stat(messagesDir); err != nil {
		return // nothing to migrate
	}

	// 1. Build ccd_session_id → pokegent_id map from all running files.
	rfEntries, err := os.ReadDir(runningDir)
	if err != nil {
		return
	}
	ccdToPGID := map[string]string{}
	for _, e := range rfEntries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(runningDir, e.Name()))
		if err != nil {
			continue
		}
		var rf struct {
			PokegentID   string `json:"pokegent_id"`
			CCDSessionID string `json:"ccd_session_id"`
		}
		if err := json.Unmarshal(data, &rf); err != nil {
			continue
		}
		if rf.PokegentID != "" && rf.CCDSessionID != "" && rf.PokegentID != rf.CCDSessionID {
			ccdToPGID[rf.CCDSessionID] = rf.PokegentID
		}
	}
	if len(ccdToPGID) == 0 {
		return // nothing maps cleanly
	}

	// 2. Walk mailbox directories, migrate the ones whose name is a known ccd_id.
	mbEntries, err := os.ReadDir(messagesDir)
	if err != nil {
		return
	}
	migrated := 0
	for _, e := range mbEntries {
		if !e.IsDir() {
			continue
		}
		dirName := e.Name()
		pgid, hasMapping := ccdToPGID[dirName]
		if !hasMapping {
			continue // not a known ccd_id; either already a pgid mailbox or an orphan
		}
		srcDir := filepath.Join(messagesDir, dirName)
		dstDir := filepath.Join(messagesDir, pgid)
		if err := mergeMailboxDir(srcDir, dstDir); err != nil {
			log.Printf("mailbox migration: %s → %s: %v", dirName[:min(8, len(dirName))], pgid[:min(8, len(pgid))], err)
			continue
		}
		// Source dir should now be empty; remove it.
		_ = os.Remove(srcDir)
		migrated++
	}
	if migrated > 0 {
		log.Printf("mailbox migration: moved %d mailbox(es) from ccd_session_id → pokegent_id keying", migrated)
	}
}

// mergeMailboxDir moves every regular file from src to dst. If dst already has
// a file with the same name, the source file is renamed with a `.migrated`
// suffix so nothing is lost. dst is created if it doesn't exist.
func mergeMailboxDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		// Skip per-launch ephemeral state (budget files etc., names starting
		// with `_`) — those are stale at the source and the destination
		// already has its own current copy. Reset-on-UserPromptSubmit means
		// any drift here gets corrected on the next turn anyway.
		if strings.HasPrefix(e.Name(), "_") {
			_ = os.Remove(filepath.Join(src, e.Name()))
			continue
		}
		srcPath := filepath.Join(src, e.Name())
		dstPath := filepath.Join(dst, e.Name())
		if _, err := os.Stat(dstPath); err == nil {
			// Collision — keep both, rename source to *.migrated.
			alt := filepath.Join(dst, e.Name()+".migrated")
			if err := os.Rename(srcPath, alt); err != nil {
				return fmt.Errorf("rename collision %s: %w", e.Name(), err)
			}
			continue
		}
		if err := os.Rename(srcPath, dstPath); err != nil {
			return fmt.Errorf("move %s: %w", e.Name(), err)
		}
	}
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
