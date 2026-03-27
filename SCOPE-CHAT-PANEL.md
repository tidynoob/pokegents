# Scope: In-Dashboard Chat Panel

## Overview

Add a VS Code Claude Code-like chat panel to the pokegents dashboard. Clicking an agent card opens a side panel showing the full conversation with readable message bubbles and an input box to send prompts — no need to switch to iTerm.

## User Experience

1. Click agent card (or a "Chat" button) → right panel slides open (50-60% width)
2. Panel shows the full conversation: user messages, assistant responses, tool calls (collapsible), thinking blocks (collapsible), system messages
3. Input box at the bottom to type and send prompts (same as current QuickInput but full-width, multi-line)
4. Real-time updates: new messages appear as the agent works (streaming-like feel from polling)
5. Panel header shows agent name, sprite, status badge, close button
6. ESC or close button dismisses the panel
7. Multiple panels not needed — one agent at a time

## Technical Approach

### Backend: New API Endpoint

**`GET /api/sessions/{id}/transcript?after={uuid}&tail={n}`**

Returns parsed transcript entries from the JSONL file. Two modes:
- `tail=100` — last N entries (initial load)
- `after=<uuid>` — entries after a given message UUID (polling for new messages)

Response format:
```json
{
  "entries": [
    {
      "uuid": "d4e67af8-...",
      "type": "user",
      "timestamp": "2026-03-23T23:25:55.537Z",
      "content": "can u do a read of all the git diffs?"
    },
    {
      "uuid": "7d8b58d6-...",
      "type": "assistant",
      "timestamp": "2026-03-23T23:26:00.940Z",
      "blocks": [
        { "type": "thinking", "text": "Let me check the git status..." },
        { "type": "text", "text": "Let me pull up all the diffs." },
        { "type": "tool_use", "name": "Bash", "input": { "command": "git diff HEAD", "description": "Show all staged and unstaged changes" } }
      ],
      "model": "claude-opus-4-6",
      "tokens": { "input": 15256, "output": 9, "cache_read": 15256, "cache_create": 6228 }
    },
    {
      "uuid": "09a1776b-...",
      "type": "tool_result",
      "tool_use_id": "toolu_01PwBF...",
      "content": "diff --git a/file.go b/file.go\n+new line\n-old line",
      "truncated": true,
      "full_size": 75000
    }
  ],
  "has_more": false
}
```

**Why a new endpoint instead of reading JSONL on the frontend:**
- JSONL files are on the server filesystem, not accessible to the browser
- Server-side parsing filters out noise (progress entries, hook summaries, file-history-snapshot)
- Server can handle the 256KB+ read window and pagination
- Consistent with existing architecture (server reads files, frontend gets JSON)

**Implementation:** ~150 lines in server.go handler + a `parseTranscript` function in state.go or store/transcript.go. Reads from `FindTranscriptPath(sessionID)`, parses JSONL, filters to user/assistant/system entries, transforms to the response format above.

### Backend: Prompt Submission

Already exists: `POST /api/sessions/{id}/prompt` with `{ "prompt": "..." }`. Types text into the terminal via AppleScript. No changes needed.

### Frontend: ChatPanel Component

New component: `dashboard/web/src/components/ChatPanel.tsx`

**Structure:**
```
ChatPanel (fixed right panel, 50-60% width)
├── Header (agent name, sprite, status, close button)
├── MessageList (scrollable, auto-scroll to bottom)
│   ├── UserMessage (right-aligned bubble, blue tint)
│   ├── AssistantMessage
│   │   ├── ThinkingBlock (collapsible, muted italic)
│   │   ├── TextBlock (markdown rendered)
│   │   └── ToolUseBlock (collapsible, shows tool name + input summary)
│   ├── ToolResultBlock (collapsible, shows output preview)
│   └── SystemMessage (centered, muted)
├── StatusBar (typing indicator when busy, token count)
└── InputBox (multi-line textarea, Shift+Enter for newline, Enter to send)
```

**Estimated size:** ~400-500 lines for the component + ~50 lines for a markdown renderer helper.

**Polling:** Every 2 seconds when panel is open and agent is busy. Passes `after=<last_uuid>` to only get new entries. When agent is idle/done, poll every 10s (or stop).

### Frontend: Integration in App.tsx

- New state: `selectedAgentId: string | null`
- Clicking card sets `selectedAgentId` (in addition to focusing iTerm)
- When `selectedAgentId` is set, render `<ChatPanel>` as a right side panel
- Grid shrinks to accommodate the panel (CSS: `grid` with panel taking fixed width)
- Agent cards still visible on the left, selected card highlighted

### Markdown Rendering

For assistant text blocks, we need basic markdown rendering:
- Bold, italic, code spans (inline)
- Code blocks with syntax highlighting (optional, can use a simple `<pre>` initially)
- Links
- Lists, headers

Options:
1. **Minimal custom renderer** (~100 lines) — handles bold, code, links. Good enough for v1.
2. **react-markdown + rehype** — full markdown support, adds ~50KB to bundle. Better for v2.

Recommendation: Start with option 1 (we already have a basic `formatMarkdown` in AgentCard.tsx), upgrade to react-markdown later if needed.

### Tool Call Display

Tool calls should be collapsible cards showing:
- Tool name (Bash, Read, Edit, Grep, etc.)
- Brief input summary (e.g., "git diff HEAD" for Bash, file path for Read)
- Expandable to show full input JSON
- Tool result: show first ~20 lines, expandable to full output
- Color-coded: green border for success, red for errors

## Complexity Estimate

| Component | Lines | Effort |
|-----------|-------|--------|
| Server: transcript parsing endpoint | ~150 | Low — mostly JSONL parsing, similar to existing extractors |
| Server: response types | ~30 | Trivial |
| Frontend: ChatPanel component | ~450 | Medium — message rendering, auto-scroll, polling |
| Frontend: MessageBubble sub-components | ~200 | Medium — tool calls, thinking blocks, collapsibles |
| Frontend: App.tsx integration | ~30 | Low — state + conditional render |
| Frontend: CSS/styling | ~50 | Low |
| **Total** | **~910** | **Medium** |

## Dependencies

- No new npm packages needed for v1 (custom markdown renderer)
- No new Go packages needed
- Relies on existing `FindTranscriptPath` and JSONL parsing

## Risks and Edge Cases

1. **Large transcripts** — sessions with 1000+ messages. Mitigation: pagination with `tail=100` for initial load, `after=uuid` for incremental. Never load the full transcript.
2. **Compacted sessions** — after `/compact`, old messages are summarized. The transcript still has entries but earlier ones may be summaries. Display "Conversation compacted" marker.
3. **Forked sessions** — clone sessions share history with the original. The transcript path is the clone's own JSONL (which starts from the fork point). No special handling needed.
4. **Concurrent edits** — user types in both the panel input AND iTerm. Both work (panel uses the same `sendPrompt` API which types into terminal). The panel just shows what's in the transcript.
5. **Sub-agents** — Claude Code's internal Agent tool spawns sub-agents whose messages appear as `progress` entries with `agent_progress` type. These should be rendered as nested/indented blocks.
6. **Binary/image content** — tool results can reference images or large binary outputs. Show a placeholder with file path, not the content.
7. **Streaming feel** — Claude Code doesn't expose a streaming API for the transcript. We poll every 2s. To make it feel more responsive, we could watch the JSONL file via the store watcher and push updates via SSE. This is a v2 optimization.

## Out of Scope (v1)

- Syntax highlighting in code blocks (just `<pre>` with monospace)
- Image rendering (show file path only)
- Message editing / regeneration
- Branch navigation (following sidechains)
- Split view (two agents side by side)
- Direct streaming (SSE for transcript changes)

## Open Questions

1. Should clicking a card open the panel OR focus iTerm? Currently it focuses iTerm. Options:
   - Single click = panel, double click = iTerm
   - Click card body = panel, click sprite = iTerm
   - Add an explicit "Chat" button to the card
2. Should the panel replace the agent grid or overlay it? Overlay keeps context but reduces space. Replace is cleaner but loses the overview.
3. Should we support keyboard navigation between agents while panel is open (arrow keys)?
