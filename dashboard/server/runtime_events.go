package server

import "encoding/json"

type RuntimeEventType string

const (
	EventAgentBusy     RuntimeEventType = "agent_busy"
	EventAgentIdle     RuntimeEventType = "agent_idle"
	EventTaskStarted   RuntimeEventType = "task_started"
	EventTaskProgress  RuntimeEventType = "task_progress"
	EventTaskCompleted RuntimeEventType = "task_completed"
	EventMessageChunk  RuntimeEventType = "message_chunk"
	EventToolCall      RuntimeEventType = "tool_call"
	EventToolUpdate    RuntimeEventType = "tool_update"
	EventUsageUpdate   RuntimeEventType = "usage_update"
	EventRateLimit     RuntimeEventType = "rate_limit"
	EventAPIRetry      RuntimeEventType = "api_retry"
	EventError         RuntimeEventType = "error"
)

type RuntimeEvent struct {
	Type    RuntimeEventType
	TurnID  uint64
	SeqNo   uint64
	Payload json.RawMessage
}
