package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"

	"ccd/dashboard/server"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: ccd-dashboard <command>")
		fmt.Println("Commands:")
		fmt.Println("  serve    Start the dashboard server")
		fmt.Println("  index    Build the search index and exit")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "serve":
		runServe()
	case "index":
		runIndex()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func runServe() {
	cfg := server.DefaultConfig()

	// Override from environment
	if v := os.Getenv("CCD_DATA"); v != "" {
		cfg.CCDData = v
	}
	if v := os.Getenv("DASHBOARD_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			cfg.Port = p
		}
	}

	// Find web directory: check relative to binary, then cwd
	for _, candidate := range []string{
		filepath.Join(filepath.Dir(os.Args[0]), "web", "dist"),
		filepath.Join("web", "dist"),
	} {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			cfg.WebDir = candidate
			break
		}
	}

	s, err := server.NewServer(cfg)
	if err != nil {
		log.Fatalf("failed to create server: %v", err)
	}
	defer s.Stop()

	if err := s.Start(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func runIndex() {
	cfg := server.DefaultConfig()
	if v := os.Getenv("CCD_DATA"); v != "" {
		cfg.CCDData = v
	}

	state := server.NewStateManager(cfg.CCDData, cfg.ClaudeProjectDir)
	state.LoadAll()

	search, err := server.NewSearchIndex(cfg.SearchDBPath, cfg.ClaudeProjectDir, state)
	if err != nil {
		log.Fatalf("failed to create search index: %v", err)
	}
	defer search.Close()

	log.Println("Building search index...")
	search.BuildIndex()
	log.Println("Done.")
}
