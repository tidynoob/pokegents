//go:build !darwin

package server

import "fmt"

// StubTerminal is a no-op terminal integration for non-macOS platforms.
type StubTerminal struct{}

// NewTerminal returns the platform terminal integration.
func NewTerminal() TerminalIntegration {
	return &StubTerminal{}
}

var errUnavailable = fmt.Errorf("terminal integration requires iTerm2 on macOS")

func (t *StubTerminal) IsAvailable() bool                                  { return false }
func (t *StubTerminal) FocusSession(itermSessionID, tty string) error      { return errUnavailable }
func (t *StubTerminal) WriteText(itermSessionID, tty, text string) error   { return errUnavailable }
func (t *StubTerminal) SetTabName(itermSessionID, tty, name string) error  { return errUnavailable }
func (t *StubTerminal) CloseSession(itermSessionID, tty string) error      { return errUnavailable }
func (t *StubTerminal) CloneSession(profile, sessionIDPrefix string) error  { return errUnavailable }
func (t *StubTerminal) ResumeSession(profile, sessionID string) error       { return errUnavailable }
func (t *StubTerminal) LaunchProfile(profile, itermProfile string) error    { return errUnavailable }
