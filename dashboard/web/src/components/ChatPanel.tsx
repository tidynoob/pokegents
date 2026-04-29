import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AgentState } from '../types'
import { fetchTranscript, TranscriptEntry, renameAgent, setSprite, fetchProjectList, fetchRoleList, ProjectInfo, RoleInfo } from '../api'
import { Markdown } from './Markdown'
import { PromptInput } from './PromptInput'
import { StateBadge, AgentLifecycleState } from './StateBadge'
import { ChatStatusBar } from './ChatStatusBar'
import { formatElapsed } from '../utils/elapsed'
import { AgentMenu } from './AgentMenu'
import { SpritePicker } from './SpritePicker'
import { useRuntimeCapabilities, capsFor } from '../utils/runtimes'
import { CreatureIcon } from './CreatureIcon'
import { useSpriteAnimation } from './spriteAnimations'
import { HealthBar, ProfilePill, RolePill, TaskGroupPill } from './AgentCard'
import { BusyBubble, DoneBubble } from './MessageAnimations'
import {
  BgShell,
  extractTaskId,
  isBackgroundSpawn,
  followupTool,
  extractBashCommand,
  readToolText,
  parseBashOutputCompletion,
} from '../utils/bgShells'

// Right-side split panel for chat-backed pokegents (`agent.interface === 'chat'`).
// Streams ACP `session/update` notifications over SSE from
// /api/chat/{pokegent_id}/stream and submits prompts via /api/chat/{pgid}/prompt.
// ACP wire-format reference: https://agentclientprotocol.com (schema 0.12.x).
//
// Visual: terminal-dark transcript body inside a blue gba-card frame. Markdown
// rendering via react-markdown + remark-gfm; code blocks syntax-highlighted via
// prism-react-renderer; links open in a new tab.

type ContentBlock = { type: 'text'; text: string } | { type: string; [k: string]: unknown }
type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

interface ToolCall {
  toolCallId: string
  title?: string
  kind?: string
  status?: ToolStatus
  locations?: { path: string; line?: number }[]
  // ACP emits these as opaque payloads — they may be a JSON-stringifiable
  // object, a pre-stringified string, or an array of content blocks. We
  // render whatever we get with `typeof === 'string' ? value : JSON.stringify`.
  rawInput?: unknown
  rawOutput?: unknown
  content?: unknown[]
}

type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | ({ sessionUpdate: 'tool_call' } & ToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCall)
  | { sessionUpdate: 'session_info_update'; title?: string }
  | { sessionUpdate: string; [k: string]: unknown }

interface SessionUpdateEnvelope { sessionId?: string; update: SessionUpdate }

interface PermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thoughts: string }
  | { kind: 'tool'; id: string; data: ToolCall }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'permission'; id: string; requestId: number; toolCall?: ToolCall; options: PermissionOption[]; resolved?: 'allowed' | 'denied' | 'pending' }

// renderRawPayload turns ACP's opaque rawInput/rawOutput into something
// readable. ACP doesn't pin a type — it could be a string, an object, or
// even an array. JSON.stringify is the safe fallback; pre-stringified
// strings pass through.
function renderRawPayload(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function textOf(content: ContentBlock | undefined): string {
  if (!content) return ''
  if (content.type === 'text' && typeof (content as { text?: string }).text === 'string') {
    return (content as { text: string }).text
  }
  return ''
}

interface ChatPanelProps {
  agent: AgentState
  onClose: () => void
}

export function ChatPanel({ agent, onClose }: ChatPanelProps) {
  const pokegentId = agent.pokegent_id || agent.session_id
  const [entries, setEntries] = useState<Entry[]>([])
  const [streamReady, setStreamReady] = useState(false)
  const [title, setTitle] = useState<string>('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [showSpritePicker, setShowSpritePicker] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [editName, setEditName] = useState(agent.display_name || '')
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const editNameRef = useRef<HTMLInputElement>(null)
  const turnIdRef = useRef(0)
  // Queued messages: prompts sent while the agent is busy. They're held in
  // ACP's in-memory queue and won't appear in the transcript until processed.
  // Show them above the input so the user knows they were received.
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])
  const allCaps = useRuntimeCapabilities()
  const caps = capsFor(allCaps, agent.interface)

  // Search state
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIdx, setSearchMatchIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Lazy-load projects/roles for the AgentMenu submenus. Cached at the
  // module level by the API layer's HTTP caching, so no extra cost.
  useEffect(() => {
    fetchProjectList().then(setProjects).catch(() => {})
    fetchRoleList().then(setRoles).catch(() => {})
  }, [])

  useEffect(() => {
    if (editingName) {
      editNameRef.current?.focus()
      editNameRef.current?.select()
    }
  }, [editingName])

  async function commitRename() {
    const newName = editName.trim()
    setEditingName(false)
    if (newName && newName !== agent.display_name) {
      await renameAgent(agent.session_id, newName)
    }
  }

  // Local optimistic busy state — set the moment the SSE `state` event
  // fires from the chat backend (~10ms after Prompt() starts) so the UI
  // flips to BUSY instantly. The canonical agent.state from the status
  // pipeline takes ~50-200ms to propagate (file write → fsnotify →
  // state.go → SSE state_update), which is enough lag to look broken.
  // We OR the two: local optimistic for instant feedback, canonical as
  // the slower-but-authoritative truth.
  const [optimisticBusy, setOptimisticBusy] = useState(false)
  const [optimisticBusySince, setOptimisticBusySince] = useState<string | null>(null)

  // Background shells the agent has spawned via Bash(run_in_background=true).
  // Tracked separately from the transcript so the StatusBar below the input
  // can show a live list with running/completed/killed state. ACP doesn't
  // expose a dedicated "background task" event — we infer lifecycle from
  // tool_call / tool_call_update events: see utils/bgShells.ts.
  const [bgShells, setBgShells] = useState<Map<string, BgShell>>(() => new Map())
  // taskId → toolCallId map: lets us match Bash(run_in_background=true)'s
  // tool_call event (which has the toolCallId but no task_id yet) to the
  // tool_call_update that carries the result text containing the task_id.
  const pendingSpawnRef = useRef<Map<string, string>>(new Map())

  // Reconfigure window — when the user runs /model or /effort, the chat
  // backend closes the ACP session and respawns it with new options. The
  // SSE connection drops + reconnects; the browser may briefly see
  // streamReady=false and an `exit` event. We track an "intentional
  // reconfigure" window so we (a) don't show the alarming "Chat process
  // exited." entry, (b) keep the badge in a calm "RECONFIG" state instead
  // of "CONN", and (c) emit a single confirmation entry once the new
  // session connects. Tuple of {endsAt, pendingMsg} where pendingMsg is
  // shown after reconnect.
  const reconfigureRef = useRef<{ endsAt: number; pendingMsg: string } | null>(null)
  const [reconfiguring, setReconfiguring] = useState(false)

  // Reconfigure-window safety expiry — if the new session never connects
  // (relaunch failed silently, browser EventSource didn't reconnect),
  // clear the window so the user isn't stuck on a "RECONFIG" badge
  // forever and gets the normal connecting/exit flow back.
  useEffect(() => {
    if (!reconfiguring) return
    const rc = reconfigureRef.current
    if (!rc) return
    const wait = Math.max(0, rc.endsAt - Date.now())
    const t = setTimeout(() => {
      if (reconfigureRef.current === rc) {
        reconfigureRef.current = null
        setReconfiguring(false)
        appendEntry({
          kind: 'system',
          id: `e-${turnIdRef.current++}`,
          text: 'Reconfigure timeout — agent did not reconnect. Try /cancel and re-issue.',
        })
      }
    }, wait + 100)
    return () => clearTimeout(t)
  }, [reconfiguring])

  // SSE-drop fallback: if the optimistic busy flag stuck (we missed the
  // 'state':done event because the SSE connection dropped mid-turn), the
  // canonical agent.state arriving as idle/done/error from the dashboard's
  // own state_update stream is our authoritative reset. Without this, the
  // BUSY badge could stick forever after a connection blip.
  useEffect(() => {
    if (agent.state && agent.state !== 'busy') {
      setOptimisticBusy(false)
      setOptimisticBusySince(null)
    }
  }, [agent.state])

  const isBusy = optimisticBusy || agent.state === 'busy'
  const busySinceTs = optimisticBusySince || agent.busy_since
  // Reconfiguring overrides connecting/busy when active — the user
  // triggered the restart, so the disconnect dance shouldn't read as
  // failure or busy work.
  const lifecycle: AgentLifecycleState = reconfiguring
    ? 'reconfiguring'
    : !streamReady
    ? 'connecting'
    : isBusy
      ? 'busy'
      : agent.state === 'error'
        ? 'error'
        : agent.state === 'needs_input'
          ? 'needs_input'
          : agent.state === 'done'
            ? 'done'
            : 'idle'

  // Reset transcript when switching agents.
  useEffect(() => {
    setEntries([])
    setStreamReady(false)
    setTitle('')
    setOptimisticBusy(false)
    setOptimisticBusySince(null)
    setBgShells(new Map())
    pendingSpawnRef.current = new Map()
    reconfigureRef.current = null
    setReconfiguring(false)
    turnIdRef.current = 0
    stickToBottomRef.current = true
  }, [pokegentId])

  // Auto-clear completed/killed/failed bg shells ~5s after they end so
  // the footer doesn't accumulate noise.
  useEffect(() => {
    const stale: string[] = []
    bgShells.forEach((s, id) => {
      if (s.status !== 'running' && s.endedAt && Date.now() - s.endedAt > 5000) {
        stale.push(id)
      }
    })
    if (stale.length === 0) {
      // If any shell is ended-but-not-yet-stale, schedule a tick.
      let earliest = Infinity
      bgShells.forEach(s => {
        if (s.status !== 'running' && s.endedAt) earliest = Math.min(earliest, s.endedAt)
      })
      if (earliest !== Infinity) {
        const wait = Math.max(100, 5000 - (Date.now() - earliest))
        const t = setTimeout(() => setBgShells(prev => new Map(prev)), wait)
        return () => clearTimeout(t)
      }
      return
    }
    setBgShells(prev => {
      const next = new Map(prev)
      stale.forEach(id => next.delete(id))
      return next
    })
  }, [bgShells])

  // JSONL backfill — seed from the on-disk transcript so opening the panel
  // on an existing chat (or a migrated agent) shows full history immediately.
  useEffect(() => {
    if (!agent.session_id) return
    let cancelled = false
    fetchTranscript(agent.session_id, 5000).then(page => {
      if (cancelled) return
      const seeded = entriesFromTranscript(page.entries || [])
      if (seeded.length === 0) return
      setEntries(prev => (prev.length > 0 ? prev : seeded))
      turnIdRef.current = seeded.length
    }).catch(() => { /* no transcript yet — fine */ })
    return () => { cancelled = true }
  }, [agent.session_id])

  // SSE subscription.
  useEffect(() => {
    if (!pokegentId) return
    const es = new EventSource(`/api/chat/${pokegentId}/stream`)
    es.onopen = () => {
      setStreamReady(true)
      // If we're in a reconfigure window, this onopen is the new session
      // coming up after a /model or /effort restart. Emit the queued
      // confirmation entry so the user sees clear closure.
      const rc = reconfigureRef.current
      if (rc && Date.now() < rc.endsAt) {
        if (rc.pendingMsg) {
          appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: rc.pendingMsg })
        }
        reconfigureRef.current = null
        setReconfiguring(false)
      }
    }

    es.addEventListener('session_update', (e) => {
      try {
        const env = JSON.parse((e as MessageEvent).data) as SessionUpdateEnvelope
        applyUpdate(env.update)
      } catch (err) { console.warn('chat: bad session_update', err) }
    })
    es.addEventListener('permission_request', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          request_id: number
          toolCall?: ToolCall
          options: PermissionOption[]
        }
        if (data.request_id == null || !Array.isArray(data.options)) return
        setEntries(prev => {
          if (prev.some(en => en.kind === 'permission' && en.requestId === data.request_id)) return prev
          return [...prev, {
            kind: 'permission',
            id: `perm-${data.request_id}`,
            requestId: data.request_id,
            toolCall: data.toolCall,
            options: data.options,
            resolved: 'pending',
          }]
        })
      } catch { /* ignore */ }
    })
    // SSE 'state' events flip optimisticBusy *instantly* — the canonical
    // agent.state from the status-file pipeline arrives ~50-200ms later.
    es.addEventListener('state', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { state?: string }
        if (data?.state === 'busy') {
          setOptimisticBusy(true)
          setOptimisticBusySince(new Date().toISOString())
          // A new busy state means a queued message was picked up — shift it.
          setQueuedMessages(prev => prev.length > 0 ? prev.slice(1) : prev)
        }
        if (data?.state === 'idle' || data?.state === 'done') {
          setOptimisticBusy(false)
          setOptimisticBusySince(null)
        }
      } catch { /* ignore */ }
    })
    es.addEventListener('exit', () => {
      // Suppress the alarming "Chat process exited." line during an
      // intentional reconfigure window — the new session is coming. The
      // server-side change to handleChatStream returns after `exit` so
      // the EventSource will auto-reconnect and onopen will fire when
      // the relaunched session is ready.
      const rc = reconfigureRef.current
      const intentional = rc && Date.now() < rc.endsAt
      if (!intentional) {
        appendEntry({ kind: 'system', id: `exit-${turnIdRef.current++}`, text: 'Chat process exited.' })
      }
      setStreamReady(false)
    })
    es.onerror = () => { /* auto-reconnects */ }

    return () => { es.close() }
  }, [pokegentId])

  // Sticky-bottom auto-scroll: only follow new content if the user is
  // already pinned within `STICKY_BOTTOM_PX` of the bottom. The moment
  // they scroll up to re-read something, we leave their scroll position
  // alone — even as new entries / streaming chunks arrive. They can pin
  // back to the bottom by scrolling there manually, at which point
  // following resumes.
  // Initial value: true. Opening the panel should pin to the latest
  // entries; the user can scroll up to disengage.
  const STICKY_BOTTOM_PX = 80
  const stickToBottomRef = useRef(true)
  // When switching agents, reset scroll to bottom.
  useEffect(() => {
    stickToBottomRef.current = true
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [pokegentId])
  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom <= STICKY_BOTTOM_PX
  }
  useEffect(() => {
    if (!stickToBottomRef.current) return
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [entries])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl/Cmd+F opens search
      if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 0)
        return
      }
      // Escape: close search first, then close panel
      if (e.key === 'Escape') {
        if (searchOpen) {
          setSearchOpen(false)
          setSearchQuery('')
          return
        }
        onClose()
        return
      }
      // Ctrl+C or Ctrl+B cancels/backgrounds the current turn.
      // During a Bash tool call, the SDK backgrounds the process rather
      // than killing it — same as Ctrl+B in the Claude terminal.
      if ((e.key === 'c' || e.key === 'b') && (e.ctrlKey || e.metaKey) && isBusy) {
        if (e.key === 'c' && window.getSelection()?.toString()) return // don't hijack copy
        e.preventDefault()
        cancel()
        appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: 'Interrupted. What would you like me to do?' })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, isBusy, searchOpen])

  function appendEntry(e: Entry) { setEntries(prev => [...prev, e]) }

  const applyUpdate = useCallback((u: SessionUpdate) => {
    setEntries(prev => {
      const next = [...prev]
      const last = next[next.length - 1]

      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          const t = textOf((u as { content: ContentBlock }).content)
          if (last && last.kind === 'assistant') {
            next[next.length - 1] = { ...last, text: last.text + t }
          } else {
            next.push({ kind: 'assistant', id: `a-${turnIdRef.current++}`, text: t, thoughts: '' })
          }
          return next
        }
        case 'agent_thought_chunk': {
          const t = textOf((u as { content: ContentBlock }).content)
          if (last && last.kind === 'assistant') {
            next[next.length - 1] = { ...last, thoughts: last.thoughts + t }
          } else {
            next.push({ kind: 'assistant', id: `a-${turnIdRef.current++}`, text: '', thoughts: t })
          }
          return next
        }
        case 'user_message_chunk': {
          // Synthetic event emitted server-side by ChatSession.Prompt so
          // prompts sent from anywhere (ChatPanel here, AgentCard's
          // QuickInput, future API consumers) appear in the transcript.
          // ChatPanel.submitText also appends the user message locally for
          // instant feedback, so de-dup here: if the last entry is already
          // a user message with the same text, skip — that's our own echo.
          // Otherwise (prompt sent from AgentCard while panel is open)
          // push a new user entry.
          const ut = textOf((u as { content: ContentBlock }).content)
          if (last && last.kind === 'user' && last.text === ut) {
            return next
          }
          next.push({ kind: 'user', id: `u-${turnIdRef.current++}`, text: ut })
          return next
        }
        case 'tool_call': {
          const tc = u as unknown as ToolCall
          // Background-shell spawn: the initial tool_call doesn't have the
          // task_id yet (output isn't populated), but mark this toolCallId
          // as "pending spawn" so the matching tool_call_update can resolve.
          if (isBackgroundSpawn(tc.kind, tc.rawInput)) {
            pendingSpawnRef.current.set(tc.toolCallId, extractBashCommand(tc.rawInput))
          }
          next.push({ kind: 'tool', id: tc.toolCallId, data: tc })
          return next
        }
        case 'tool_call_update': {
          const tc = u as unknown as ToolCall
          // Resolve pending background-shell spawns: the update carries
          // the rawOutput / content with the task_id. Promote it into our
          // bgShells map.
          const pendingCmd = pendingSpawnRef.current.get(tc.toolCallId)
          if (pendingCmd !== undefined && tc.status === 'completed') {
            const taskId = extractTaskId(tc.rawOutput, tc.content) || tc.toolCallId
            pendingSpawnRef.current.delete(tc.toolCallId)
            const cmd = pendingCmd || extractBashCommand(tc.rawInput)
            setBgShells(prev => {
              if (prev.has(taskId)) return prev
              const out = new Map(prev)
              out.set(taskId, {
                taskId,
                command: cmd,
                startedAt: Date.now(),
                status: 'running',
              })
              return out
            })
          }
          // Follow-up tool calls (BashOutput / KillShell) update an
          // existing tracked shell.
          const followup = followupTool(tc.title, tc.kind)
          if (followup && tc.status === 'completed') {
            const targetTaskId = extractTaskId(tc.rawInput, tc.rawOutput, tc.content)
            if (targetTaskId) {
              const text = readToolText(tc.content) || (typeof tc.rawOutput === 'string' ? tc.rawOutput : '')
              if (followup === 'kill') {
                setBgShells(prev => {
                  const cur = prev.get(targetTaskId)
                  if (!cur) return prev
                  const out = new Map(prev)
                  out.set(targetTaskId, { ...cur, status: 'killed', endedAt: Date.now(), lastOutput: text || cur.lastOutput })
                  return out
                })
              } else if (followup === 'output') {
                const completion = parseBashOutputCompletion(text)
                setBgShells(prev => {
                  const cur = prev.get(targetTaskId)
                  const out = new Map(prev)
                  if (!cur) {
                    // Shell wasn't tracked from spawn (e.g. backgrounded mid-run
                    // or spawned before this panel connected). Create it now.
                    out.set(targetTaskId, {
                      taskId: targetTaskId,
                      command: tc.title || 'background task',
                      startedAt: Date.now(),
                      status: completion ? completion.status : 'running',
                      endedAt: completion ? Date.now() : undefined,
                      exitCode: completion?.exitCode,
                      lastOutput: text,
                    })
                  } else {
                    out.set(targetTaskId, {
                      ...cur,
                      status: completion ? completion.status : cur.status,
                      endedAt: completion ? Date.now() : cur.endedAt,
                      exitCode: completion?.exitCode ?? cur.exitCode,
                      lastOutput: text || cur.lastOutput,
                    })
                  }
                  return out
                })
              }
            }
          }
          const idx = next.findIndex(e => e.kind === 'tool' && e.id === tc.toolCallId)
          if (idx >= 0) {
            const cur = next[idx] as Extract<Entry, { kind: 'tool' }>
            // Merge without overwriting populated fields with empty values.
            // ACP sends multiple updates: one with rawInput/content, another
            // with status/rawOutput but content=[]. Naive spread would clobber.
            const merged = { ...cur.data } as Record<string, unknown>
            for (const [k, v] of Object.entries(tc)) {
              if (k === 'sessionUpdate') continue
              if (Array.isArray(v) && v.length === 0 && Array.isArray(merged[k]) && (merged[k] as unknown[]).length > 0) continue
              if (k === 'rawInput' && typeof v === 'object' && v !== null && Object.keys(v).length === 0 && merged[k] != null && typeof merged[k] === 'object' && Object.keys(merged[k] as object).length > 0) continue
              if (v !== undefined) merged[k] = v
            }
            next[idx] = { ...cur, data: merged as unknown as ToolCall }
          } else {
            next.push({ kind: 'tool', id: tc.toolCallId, data: tc })
          }
          return next
        }
        case 'session_info_update': {
          const t = (u as { title?: string }).title
          if (typeof t === 'string') setTitle(t)
          return next
        }
        default:
          return next
      }
    })
  }, [])

  async function submitText(text: string) {
    if (!pokegentId) return
    // Intercept dashboard-level slash commands BEFORE they reach the chat
    // backend (which would otherwise pass them to Claude as literal text).
    // The CLI's slash-command parser doesn't exist on the chat side; the
    // ACP wrapper forwards prompts straight to the model.
    if (text.startsWith('/')) {
      const head = text.split(/\s+/, 1)[0]
      switch (head) {
        case '/cancel':
          await cancel()
          appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: 'Cancelled current turn.' })
          return
        case '/clear':
          // Local-only: clear the in-memory transcript display. The JSONL
          // on disk is untouched — switching agents and back will rehydrate.
          setEntries([])
          turnIdRef.current = 0
          return
        case '/exit':
          await fetch(`/api/sessions/${pokegentId}/shutdown`, { method: 'POST' })
          appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: 'Shutdown signal sent.' })
          return
        case '/model':
        case '/effort': {
          // Both routes through the same /runtime-config endpoint. The
          // chat backend persists the new value to identity, then closes
          // and re-spawns the ACP session with `_meta.claudeCode.options`
          // carrying the new model / thinking config. Same Claude
          // session_id (so JSONL transcript continues), brief reconnect
          // blip on the panel.
          const arg = text.slice(head.length).trim()
          if (!arg) {
            appendEntry({
              kind: 'system',
              id: `s-${turnIdRef.current++}`,
              text: head === '/model'
                ? 'Usage: /model <name>  (e.g. /model claude-opus-4-7)'
                : 'Usage: /effort <level>  (low / medium / high / max)',
            })
            return
          }
          if (head === '/effort' && !['low', 'medium', 'high', 'max'].includes(arg)) {
            appendEntry({
              kind: 'system',
              id: `s-${turnIdRef.current++}`,
              text: `/effort must be one of: low, medium, high, max — got "${arg}".`,
            })
            return
          }
          // Open the reconfigure window BEFORE issuing the API call so
          // that any `exit` SSE event from the close-then-relaunch flow
          // is suppressed (we're driving it). The window auto-clears
          // when the new session's onopen fires (or expires after 20s
          // as a safety net if the relaunch fails).
          reconfigureRef.current = {
            endsAt: Date.now() + 20000,
            pendingMsg: head === '/model'
              ? `Switched model → ${arg}.`
              : `Set thinking effort → ${arg}.`,
          }
          setReconfiguring(true)
          try {
            const r = await fetch(`/api/sessions/${pokegentId}/runtime-config`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(head === '/model' ? { model: arg } : { effort: arg }),
            })
            if (!r.ok) {
              const msg = await r.text()
              // Clear the window on error so the badge returns to normal.
              reconfigureRef.current = null
              setReconfiguring(false)
              appendEntry({ kind: 'system', id: `e-${turnIdRef.current++}`, text: `Error: ${msg}` })
            }
          } catch (err) {
            reconfigureRef.current = null
            setReconfiguring(false)
            appendEntry({ kind: 'system', id: `e-${turnIdRef.current++}`, text: `Error: ${String(err)}` })
          }
          return
        }
        case '/help':
          appendEntry({
            kind: 'system',
            id: `s-${turnIdRef.current++}`,
            text:
              'Chat-mode commands: /cancel, /clear (local only), /exit, /model <name>, /effort <low|medium|high|max>, /help.\n' +
              '/model and /effort restart the chat session under the hood — same Claude session_id is preserved.\n' +
              'Other Claude CLI commands like /compact, /cost, /memory still need iTerm2 mode.',
          })
          return
        default:
          appendEntry({
            kind: 'system',
            id: `s-${turnIdRef.current++}`,
            text:
              `${head} is a Claude CLI command and is not available in chat mode. ` +
              'Switch this agent to iTerm2 (right-click card → Switch to iTerm2) to use it. ' +
              'Type /help to see chat-mode commands.',
          })
          return
      }
    }
    // Append the user message locally — the ACP backend does NOT send a
    // `user_message_chunk` event back to subscribers (verified against
    // @zed-industries/claude-agent-acp; only agent_message_chunk,
    // tool_call(_update), usage_update, and state events flow). Without
    // this local append, two things break:
    //   1. The user's prompt never appears in the transcript at all.
    //   2. Consecutive agent_message_chunks across turns merge into one
    //      assistant entry (because applyUpdate appends to the last
    //      entry when last.kind === 'assistant') — so "Ready" + "Here." +
    //      "P" smush into "Ready.Here.P".
    // user_message_chunk's applyUpdate branch handles the de-dup case
    // where ACP *does* echo (some adapters do, in case future versions
    // add it): it merges into the existing user entry instead of pushing
    // a duplicate.
    appendEntry({ kind: 'user', id: `u-${turnIdRef.current++}`, text })
    // If the agent is busy, track this as a queued message so the UI
    // can show it above the input (survives scroll but not refresh).
    if (isBusy) {
      setQueuedMessages(prev => [...prev, text])
    }
    try {
      // Unified endpoint — dispatched server-side by agent.interface.
      const r = await fetch(`/api/sessions/${pokegentId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      })
      if (!r.ok) {
        const msg = await r.text()
        appendEntry({ kind: 'system', id: `e-${turnIdRef.current++}`, text: `Error: ${msg}` })
      }
    } catch (err) {
      appendEntry({ kind: 'system', id: `e-${turnIdRef.current++}`, text: `Error: ${String(err)}` })
    }
  }

  async function cancel() {
    if (!pokegentId) return
    await fetch(`/api/sessions/${pokegentId}/cancel`, { method: 'POST' })
  }

  async function decidePermission(requestId: number, optionId: string, cancelled: boolean) {
    if (!pokegentId) return
    setEntries(prev => prev.map(e =>
      e.kind === 'permission' && e.requestId === requestId
        ? { ...e, resolved: cancelled ? 'denied' : (optionId.startsWith('reject') ? 'denied' : 'allowed') }
        : e
    ))
    try {
      await fetch(`/api/chat/${pokegentId}/permission/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ option_id: optionId, cancelled }),
      })
    } catch (err) {
      setEntries(prev => prev.map(e =>
        e.kind === 'permission' && e.requestId === requestId ? { ...e, resolved: 'pending' } : e
      ))
      console.warn('permission decision failed', err)
    }
  }

  // Brief yellow glow flash on the panel — visual confirmation that "this
  // panel is active and responsive". Fires on open, agent switch, AND
  // re-click of the same agent card (incrementing flashKey forces the
  // effect to re-run even when pokegentId hasn't changed).
  const [glowFlash, setGlowFlash] = useState(false)
  const [flashKey, setFlashKey] = useState(0)
  // Expose a trigger the parent can call on every card click.
  useEffect(() => {
    setGlowFlash(true)
    const timer = setTimeout(() => setGlowFlash(false), 500)
    return () => clearTimeout(timer)
  }, [pokegentId, flashKey])
  // Listen for re-click of the same card (App.tsx dispatches this).
  useEffect(() => {
    const handler = () => setFlashKey(k => k + 1)
    window.addEventListener('chat-panel-ping', handler)
    return () => window.removeEventListener('chat-panel-ping', handler)
  }, [])

  return (
    <div
      className="h-full w-full flex flex-col gba-card overflow-hidden"
      style={{
        borderRadius: 8,
        background: 'linear-gradient(180deg, #3a78b0 0%, #2e6498 30%, #1f4878 100%)',
        borderColor: isBusy ? '#a04828' : undefined,
        boxShadow: glowFlash
          ? '0 0 0 2px rgba(248,216,48,0.5), 0 0 16px rgba(248,216,48,0.25)'
          : isBusy
            ? '0 0 0 2px rgba(160, 72, 40, 0.6), 0 0 12px rgba(160, 72, 40, 0.3)'
            : 'none',
        transition: 'box-shadow 0.4s ease, border-color 0.4s ease',
      }}
    >
      {/* Header — matches AgentCard layout: sprite box + name + HP bar + pills + dropdown */}
      <div
        className="px-3 py-2 border-b border-black/30 shrink-0"
        onContextMenu={(e) => { e.preventDefault(); setMenuPos({ x: e.clientX, y: e.clientY }); setMenuOpen(true) }}
      >
        <div className="flex items-center gap-3">
          {/* Sprite with background box + animations */}
          <div
            onClick={() => setShowSpritePicker(true)}
            className="cursor-pointer hover:brightness-125 relative shrink-0"
            style={{ width: 32, height: 32 }}
          >
            <div className="absolute inset-0 bg-black/20 rounded-lg" />
            <div className={`relative ${useSpriteAnimation(agent.state || 'idle', true)}`}>
              <CreatureIcon sessionId={agent.session_id} size={32} noGlow={false} doneFlash={false} spriteOverride={agent.sprite} noBg />
              <BusyBubble isBusy={isBusy} />
              <DoneBubble isDone={agent.state === 'done'} />
            </div>
          </div>
          {/* Name + HP bar */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                {editingName ? (
                  <input
                    ref={editNameRef}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingName(false)
                    }}
                    className="text-[8px] font-pixel text-white bg-transparent border-b border-white/50 outline-none w-full pixel-shadow"
                  />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <h3
                      className="text-[8px] font-pixel text-white truncate cursor-pointer hover:text-accent-yellow pixel-shadow uppercase"
                      onClick={() => { setEditName(agent.display_name || ''); setEditingName(true) }}
                    >
                      {agent.display_name || 'chat'}
                    </h3>
                    <StateBadge state={lifecycle} busySince={busySinceTs} compact />
                  </div>
                )}
                <HealthBar tokens={agent.context_tokens} window={agent.context_window} />
              </div>
              <div className={`flex flex-col items-end gap-0.5 shrink-0 ${!agent.task_group && !agent.role ? 'justify-center' : ''}`}>
                {agent.task_group && <TaskGroupPill name={agent.task_group} />}
                {agent.role && <RolePill name={agent.role} />}
                <ProfilePill name={agent.project || agent.profile_name} color={agent.project_color || agent.color} />
              </div>
            </div>
          </div>
          {/* Divider + dropdown */}
          <div className="w-px self-stretch bg-white/15 shrink-0" />
          <ChatPanelDropdown
            onSearch={() => { setSearchOpen(o => !o); if (!searchOpen) setTimeout(() => searchInputRef.current?.focus(), 0) }}
            onMenu={(e) => { setMenuPos({ x: e.clientX, y: e.clientY }); setMenuOpen(true) }}
            onCancel={isBusy && caps.can_cancel ? () => { cancel(); appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: 'Interrupted. What would you like me to do?' }) } : undefined}
            onClose={onClose}
            searchOpen={searchOpen}
          />
        </div>
      </div>

      {/* Transcript — dark terminal background inside the blue card frame.
          Default font is sans (Zed-style: prose reads naturally; code blocks
          and inline code switch to mono via their own className). */}
      <div className="flex-1 min-h-0 px-2 py-2 relative">
        {/* Search bar — VS Code style, top-right overlay */}
        {searchOpen && (
          <SearchBar
            query={searchQuery}
            onQueryChange={(q) => { setSearchQuery(q); setSearchMatchIdx(0) }}
            matchCount={searchQuery ? countSearchMatches(entries, searchQuery) : 0}
            matchIdx={searchMatchIdx}
            onNext={() => setSearchMatchIdx(i => {
              const total = countSearchMatches(entries, searchQuery)
              return total ? (i + 1) % total : 0
            })}
            onPrev={() => setSearchMatchIdx(i => {
              const total = countSearchMatches(entries, searchQuery)
              return total ? (i - 1 + total) % total : 0
            })}
            onClose={() => { setSearchOpen(false); setSearchQuery('') }}
            inputRef={searchInputRef}
          />
        )}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto overflow-x-hidden rounded-md px-3 pt-2.5 pb-10 space-y-4 font-mono"
          style={{
            background: 'rgba(0, 0, 0, 0.55)',
            boxShadow: 'inset 1px 1px 0 rgba(0,0,0,0.4)',
            fontSize: 'var(--output-font-size, 13px)',
          }}
        >
          {!streamReady && (
            <div className="text-[10px] font-mono text-white/50">Connecting…</div>
          )}
          {streamReady && entries.length === 0 && (
            <div className="text-[10px] font-mono text-white/40">Ready. Type a prompt below.</div>
          )}
          {entries.map(e => <EntryRow key={e.id} entry={e} onDecidePermission={decidePermission} searchQuery={searchQuery} />)}
          {/* Sentinel "Thinking..." row — visible while the agent is busy
              AND we haven't received any assistant-message-chunk *text* for
              this turn yet (disappears as soon as text starts streaming).
              While only thoughts are streaming, the indicator owns them
              behind a click-to-expand toggle so the user sees one row
              instead of two. */}
          {isBusy && !lastEntryIsCurrentAssistantMessage(entries) && (
            <ThinkingIndicator
              busySince={busySinceTs}
              detail={agent.detail}
              thoughts={inflightThoughts(entries)}
            />
          )}
        </div>
        {/* Floating sprite — bottom-right of transcript, 2x size */}
        <ChatPanelSprite sprite={agent.sprite} state={agent.state} />
      </div>

      {/* Queued messages — shown above the input when prompts were sent while busy */}
      {queuedMessages.length > 0 && (
        <div className="px-3 pt-1.5 shrink-0">
          <div className="text-[9px] font-mono text-amber-300/60 mb-1">
            {queuedMessages.length} queued {queuedMessages.length === 1 ? 'message' : 'messages'}
          </div>
          {queuedMessages.map((msg, i) => (
            <div key={i} className="text-[10px] font-mono text-white/40 truncate pl-2 border-l border-amber-400/30 mb-0.5">
              <span className="text-amber-300/40 mr-1">&gt;</span>{msg}
            </div>
          ))}
        </div>
      )}

      {/* Input — shared component handles auto-grow, Enter/Shift+Enter,
          and image paste (works for both runtimes via /api/sessions/{id}/image). */}
      <PromptInput
        sessionId={pokegentId}
        onSend={submitText}
        variant="chat"
        showSendButton
        autoFocus={streamReady}
        disabled={!streamReady || reconfiguring}
        placeholder={
          reconfiguring
            ? 'Reconfiguring…  hang tight'
            : streamReady
              ? `Ask ${agent.display_name || 'Claude'}…  (Enter to send, Shift+Enter for newline)`
              : 'Connecting…'
        }
        isBusy={isBusy}
      />

      <ChatStatusBar agent={agent} shells={Array.from(bgShells.values())}>
        <PromptNav entries={entries} scrollRef={scrollRef} />
      </ChatStatusBar>

      {menuOpen && createPortal(
        <AgentMenu
          x={menuPos.x}
          y={menuPos.y}
          agent={agent}
          capabilities={caps}
          projects={projects}
          roles={roles}
          onClose={() => setMenuOpen(false)}
          onRename={() => { setMenuOpen(false); setEditName(agent.display_name || ''); setEditingName(true) }}
          onChangeSprite={() => { setMenuOpen(false); setShowSpritePicker(true) }}
        />,
        document.body,
      )}
      {showSpritePicker && createPortal(
        <SpritePicker
          currentSprite={agent.sprite || 'pokeball'}
          onSelect={async (sprite) => { await setSprite(agent.session_id, sprite) }}
          onClose={() => setShowSpritePicker(false)}
        />,
        document.body,
      )}
    </div>
  )
}

// isLocalCommandArtifact matches the pseudo-XML wrappers Claude Code writes
// into the transcript when a slash-command runs (`/model`, `/clear`, etc.).
// These show up as user-type JSONL entries but they're plumbing, not
// conversation — hide them from the chat panel backfill.
function isLocalCommandArtifact(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('<local-command-') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<command-args>') ||
    t.startsWith('<command-stdout>')
  )
}

// entriesFromTranscript translates JSONL transcript entries into ChatPanel's
// Entry shape. Mirrors the SSE reducer's behavior.
function entriesFromTranscript(transcript: TranscriptEntry[]): Entry[] {
  const out: Entry[] = []
  let counter = 0
  const id = (kind: string) => `seed-${kind}-${counter++}`

  // Build a map of tool_use_id → result content for matching.
  const toolResults = new Map<string, string>()
  for (const t of transcript) {
    if (t.type === 'tool_result' && t.tool_use_id && t.content) {
      toolResults.set(t.tool_use_id, t.content)
    }
  }

  for (const t of transcript) {
    if (t.type === 'user' && t.content) {
      if (isLocalCommandArtifact(t.content)) continue
      out.push({ kind: 'user', id: id('u'), text: t.content })
      continue
    }
    if (t.type === 'assistant') {
      const blocks = t.blocks || []
      let text = ''
      let thoughts = ''
      for (const b of blocks) {
        if (b.type === 'text' && b.text) text += b.text
        else if (b.type === 'thinking' && b.text) thoughts += b.text
      }
      if (text || thoughts) out.push({ kind: 'assistant', id: id('a'), text, thoughts })
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.name) {
          const toolId = b.id || ''
          let title = b.name
          let rawInput: unknown = undefined
          try {
            const parsed = JSON.parse((b.input || '').replace(/\.\.\.$/, '') || '{}')
            rawInput = parsed
            if (parsed.command) title = `${b.name}: ${parsed.command.slice(0, 60)}`
            else if (parsed.file_path) title = `${b.name}: ${parsed.file_path}`
            else if (parsed.pattern) title = `${b.name}: ${parsed.pattern}`
          } catch { /* keep base title */ }
          const result = toolResults.get(toolId)
          out.push({
            kind: 'tool',
            id: id('t'),
            data: {
              toolCallId: toolId || id('seed-tool'),
              title,
              kind: b.name,
              status: 'completed',
              rawInput: rawInput && Object.keys(rawInput as object).length > 0 ? rawInput : undefined,
              rawOutput: result || undefined,
            },
          })
        }
      }
    }
  }
  return out
}

function EntryRow({
  entry,
  onDecidePermission,
  searchQuery,
}: {
  entry: Entry
  onDecidePermission: (requestId: number, optionId: string, cancelled: boolean) => void
  searchQuery?: string
}) {
  switch (entry.kind) {
    case 'user': {
      // Task notifications: render as a compact pill instead of raw XML.
      const taskMatch = entry.text.match(/<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/task-notification>/)
      if (taskMatch) {
        return <TaskNotificationRow text={entry.text} summary={taskMatch[1].trim()} />
      }
      // Hide local-command artifacts from live stream (backfill already filters these).
      if (isLocalCommandArtifact(entry.text)) return null
      return (
        <div className="pt-4" data-user-entry>
          <div
            className="rounded-md px-2.5 py-2 text-[11px] font-mono text-white whitespace-pre-wrap break-words leading-snug border-l-2 border-amber-400/70"
            style={{ background: 'rgba(180, 130, 40, 0.12)' }}
          >
            <span className="text-amber-300/70 mr-1">&gt;</span><HighlightText text={entry.text} query={searchQuery} />
          </div>
        </div>
      )
    }
    case 'assistant':
      return (
        <div className="text-[11px] font-mono text-white/95 leading-snug">
          {entry.thoughts && entry.text && <ThoughtsDisclosure thoughts={entry.thoughts} />}
          {entry.text ? (
            <TypewriterMarkdown text={entry.text} />
          ) : entry.thoughts ? null : <span className="text-white/30">…</span>}
        </div>
      )
    case 'tool':
      return <ToolCallRow entry={entry} />
    case 'system':
      return (
        <div className="text-[10px] font-mono text-white/40 italic leading-snug"><HighlightText text={entry.text} query={searchQuery} /></div>
      )
    case 'permission': {
      const t = entry.toolCall
      const order: Record<string, number> = { allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 }
      const opts = [...entry.options].sort((a, b) => (order[a.kind] ?? 99) - (order[b.kind] ?? 99))
      const decided = entry.resolved && entry.resolved !== 'pending'
      return (
        <div className="border border-accent-yellow/40 rounded px-2.5 py-1.5 bg-black/40">
          <div className="text-[11px] font-mono text-white/90 mb-1">
            Approve: <span className="text-accent-yellow">{t?.title || t?.kind || 'tool call'}</span>
          </div>
          {t?.locations && t.locations.length > 0 && (
            <div className="text-[10px] font-mono text-white/40 truncate mb-1">
              {t.locations.map(l => l.path + (l.line ? `:${l.line}` : '')).join(', ')}
            </div>
          )}
          {decided ? (
            <div className={`text-[8px] font-pixel ${entry.resolved === 'allowed' ? 'text-accent-green' : 'text-accent-red'}`}>
              {entry.resolved === 'allowed' ? '✓ Approved' : '✗ Denied'}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1 mt-1">
              {opts.map(o => {
                const isReject = o.kind.startsWith('reject')
                return (
                  <button
                    key={o.optionId}
                    onClick={() => onDecidePermission(entry.requestId, o.optionId, false)}
                    className={`text-[7px] font-pixel px-2 py-1 rounded transition-colors ${
                      isReject
                        ? 'bg-accent-red/20 text-accent-red hover:bg-accent-red/30'
                        : 'bg-accent-green/20 text-accent-green hover:bg-accent-green/30'
                    }`}
                    style={{ textShadow: '1px 1px 0 rgba(0,0,0,0.4)' }}
                  >
                    {o.name || o.kind}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )
    }
  }
}

// Expandable tool-call row with a tinted background so it reads as a
// distinct "event" block between assistant prose. Click the header to
// toggle the detail pane (locations, raw input/output when available).
function ToolCallRow({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const startRef = useRef(Date.now())
  const [, setTick] = useState(0)
  useEffect(() => {
    if (open) bodyRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open])
  const t = entry.data
  const status = t.status || 'pending'
  const isRunning = status === 'pending' || status === 'in_progress'

  // Tick every second while running to update elapsed time.
  useEffect(() => {
    if (!isRunning) return
    const iv = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(iv)
  }, [isRunning])

  const statusDot =
    status === 'completed' ? 'bg-accent-green' :
    status === 'failed' ? 'bg-accent-red' :
    isRunning ? 'bg-accent-yellow animate-pulse' : 'bg-white/30'

  const elapsedStr = isRunning ? (() => {
    const sec = Math.floor((Date.now() - startRef.current) / 1000)
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
  })() : null

  return (
    <div
      className={`rounded-md text-[11px] font-mono leading-snug ${isRunning ? 'border border-accent-yellow/20' : ''}`}
      style={{ background: isRunning ? 'rgba(255, 200, 60, 0.06)' : 'rgba(255,255,255,0.04)' }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 text-white/75 px-2.5 py-1.5 hover:bg-white/5 transition-colors rounded-md text-left"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
        <span className="text-white/90 font-semibold font-mono shrink-0">{t.kind || 'tool'}</span>
        {t.title && t.title !== t.kind && (
          <span className="text-white/55 truncate flex-1">— {t.title}</span>
        )}
        {isRunning && (
          <span className="text-[9px] text-accent-yellow/70 shrink-0 ml-auto mr-1 animate-pulse">
            ⋯ {elapsedStr ? `(${elapsedStr})` : ''}
          </span>
        )}
        <span className="text-[9px] text-white/30 shrink-0">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div ref={bodyRef} className="px-2.5 pb-2 space-y-1">
          {t.locations && t.locations.length > 0 && (
            <div className="text-[10px] font-mono text-white/40 truncate">
              {t.locations.map(l => l.path + (l.line ? `:${l.line}` : '')).join(', ')}
            </div>
          )}
          {/* rawInput — present on some ACP tool_call events. */}
          {t.rawInput != null && (
            <div>
              <div className="text-[9px] text-white/30 mb-0.5">Input</div>
              <pre className="text-[10px] font-mono text-white/60 bg-black/30 rounded px-2 py-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">
                {renderRawPayload(t.rawInput)}
              </pre>
            </div>
          )}
          {/* rawOutput — present on some ACP tool_call_update events. */}
          {t.rawOutput != null && (
            <div>
              <div className="text-[9px] text-white/30 mb-0.5">Output</div>
              <pre className="text-[10px] font-mono text-white/60 bg-black/30 rounded px-2 py-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">
                {renderRawPayload(t.rawOutput)}
              </pre>
            </div>
          )}
          {/* content — the ACP structured output. Array of tagged items:
              {type:"content", content:{type:"text", text:...}} — plain text output
              {type:"terminal", ...} — terminal command output
              {type:"diff", path, ...} — file diff
              Most tool results come through here, not rawInput/rawOutput. */}
          {t.content && t.content.length > 0 && (
            <div>
              {t.content.map((item: any, i: number) => {
                // Extract displayable text from the various content types.
                if (item?.type === 'content' && item?.content?.type === 'text') {
                  return (
                    <pre key={i} className="text-[10px] font-mono text-white/60 bg-black/30 rounded px-2 py-1 max-h-60 overflow-auto whitespace-pre-wrap break-all">
                      {item.content.text}
                    </pre>
                  )
                }
                if (item?.type === 'terminal' && (item?.terminalOutput || item?.command)) {
                  return (
                    <div key={i}>
                      {item.command && (
                        <div className="text-[9px] font-mono text-accent-yellow/70 mb-0.5">$ {item.command}</div>
                      )}
                      {item.terminalOutput && (
                        <pre className="text-[10px] font-mono text-white/60 bg-black/30 rounded px-2 py-1 max-h-60 overflow-auto whitespace-pre-wrap break-all">
                          {item.terminalOutput}
                        </pre>
                      )}
                    </div>
                  )
                }
                if (item?.type === 'diff') {
                  const diffText: string = item.diff || item.newContent || JSON.stringify(item, null, 2)
                  return (
                    <div key={i}>
                      {item.path && <div className="text-[9px] font-mono text-white/40 mb-0.5">{item.path}</div>}
                      <pre className="text-[10px] font-mono bg-black/30 rounded px-2 py-1 max-h-60 overflow-auto whitespace-pre-wrap break-all">
                        {diffText.split('\n').map((line: string, li: number) => {
                          let color = 'text-white/50'
                          let bg = ''
                          if (line.startsWith('+')) {
                            color = 'text-green-400'
                            bg = 'bg-green-400/10'
                          } else if (line.startsWith('-')) {
                            color = 'text-red-400'
                            bg = 'bg-red-400/10'
                          } else if (line.startsWith('@@')) {
                            color = 'text-cyan-400/70'
                          }
                          return <div key={li} className={`${color} ${bg}`}>{line}</div>
                        })}
                      </pre>
                    </div>
                  )
                }
                // Unknown content type — dump raw JSON.
                return (
                  <pre key={i} className="text-[10px] font-mono text-white/40 bg-black/30 rounded px-2 py-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(item, null, 2)}
                  </pre>
                )
              })}
            </div>
          )}
          {!t.locations?.length && t.rawInput == null && t.rawOutput == null && (!t.content || t.content.length === 0) && (
            <div className="text-[10px] text-white/25 italic">No details available</div>
          )}
        </div>
      )}
    </div>
  )
}

// TypewriterMarkdown reveals text character-by-character when new chunks
// arrive, giving the streaming a smooth animated feel instead of jarring
// block updates. Once the text stops growing (turn complete), the full
// text renders immediately so there's no lingering animation.
function TypewriterMarkdown({ text }: { text: string }) {
  const [displayed, setDisplayed] = useState(text)
  const targetRef = useRef(text)
  const rafRef = useRef<number | null>(null)
  const lastTimeRef = useRef(0)

  // Chars per frame tick. At 60fps each tick is ~16ms.
  // 3 chars/tick ≈ 180 chars/sec — fast enough to not lag behind streaming
  // but slow enough to see the text flow in.
  const CHARS_PER_TICK = 3

  useEffect(() => {
    targetRef.current = text
    if (text.length <= displayed.length) {
      setDisplayed(text)
      return
    }
    if (rafRef.current != null) return
    const step = (ts: number) => {
      if (ts - lastTimeRef.current < 12) {
        rafRef.current = requestAnimationFrame(step)
        return
      }
      lastTimeRef.current = ts
      setDisplayed(prev => {
        const target = targetRef.current
        if (prev.length >= target.length) {
          rafRef.current = null
          return target
        }
        const next = target.slice(0, prev.length + CHARS_PER_TICK)
        rafRef.current = requestAnimationFrame(step)
        return next
      })
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [text])

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
  }, [])

  return <Markdown>{displayed}</Markdown>
}

// lastEntryIsCurrentAssistantMessage returns true when the tail of the
// transcript is an assistant message that's actively streaming USER-VISIBLE
// text. We use this to suppress the "Thinking…" indicator once the agent
// has started emitting text — the streaming text itself is the activity
// indicator. Thinking-only entries (thoughts but no text) DON'T qualify:
// we keep "Thinking…" visible while the agent ruminates because we
// collapse the thoughts content by default (user can expand if curious).
function lastEntryIsCurrentAssistantMessage(entries: Entry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'user' || e.kind === 'permission' || e.kind === 'system') return false
    if (e.kind === 'assistant') return !!e.text
    // tool call: keep looking — Claude often interleaves a tool call before
    // the final text response, but we still want "Thinking…" to show while
    // the tool runs.
  }
  return false
}

// ThoughtsDisclosure shows a "Show thinking" disclosure that, when clicked,
// reveals the agent's chain-of-thought. Collapsed by default — the live
// "Thinking…" indicator at the transcript tail is sufficient feedback
// during streaming; the full thoughts are useful only when post-mortem'ing
// a turn (debug or curiosity).
// Compact task notification — shows summary with click-to-expand for full XML.
// Left/right arrows to jump between user prompts in the transcript.
function PromptNav({ entries, scrollRef }: { entries: Entry[]; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const userIndices = entries.reduce<number[]>((acc, e, i) => {
    if (e.kind === 'user') acc.push(i)
    return acc
  }, [])
  const [cursor, setCursor] = useState(-1) // -1 = no selection

  if (userIndices.length === 0) return null

  function jumpTo(idx: number) {
    setCursor(idx)
    const el = scrollRef.current
    if (!el) return
    // Find the nth user entry DOM node inside the scroll container.
    // Entry rows are direct children of the scroll div's inner content.
    const userDivs = el.querySelectorAll('[data-user-entry]')
    const target = userDivs[idx]
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const canPrev = userIndices.length > 0 && (cursor === -1 ? true : cursor > 0)
  const canNext = cursor >= 0 && cursor < userIndices.length - 1

  return (
    <span className="flex items-center gap-1">
      <span className="text-[9px] font-mono text-white/30 mr-1">
        {cursor >= 0 ? `${cursor + 1}/${userIndices.length}` : `${userIndices.length} prompts`}
      </span>
      <button
        onClick={() => jumpTo(cursor <= 0 ? userIndices.length - 1 : cursor - 1)}
        disabled={!canPrev}
        className="text-[10px] text-white/40 hover:text-white/70 disabled:opacity-20 px-1"
        title="Previous prompt"
      >◀</button>
      <button
        onClick={() => jumpTo(cursor < 0 ? 0 : cursor + 1)}
        disabled={!canNext}
        className="text-[10px] text-white/40 hover:text-white/70 disabled:opacity-20 px-1"
        title="Next prompt"
      >▶</button>
    </span>
  )
}

function TaskNotificationRow({ text, summary }: { text: string; summary: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="rounded-md text-[10px] font-mono leading-snug"
      style={{ background: 'rgba(255,255,255,0.04)' }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 text-white/60 px-2.5 py-1.5 hover:bg-white/5 transition-colors rounded-md text-left"
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-accent-green" />
        <span className="text-white/70 truncate flex-1">{summary}</span>
        <span className="text-[9px] text-white/30 shrink-0">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <pre className="text-[9px] font-mono text-white/40 bg-black/30 rounded mx-2.5 mb-2 px-2 py-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">
          {text}
        </pre>
      )}
    </div>
  )
}

function ThoughtsDisclosure({ thoughts }: { thoughts: string }) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // When the user opens the disclosure at the bottom of the transcript,
  // bring the expanded body into view (scrolls only as much as needed).
  useEffect(() => {
    if (open) bodyRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open])
  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="text-[10px] font-sans text-white/40 hover:text-white/70 italic flex items-center gap-1 transition-colors"
      >
        <span className="text-[8px]">{open ? '▼' : '▶'}</span>
        {open ? 'Hide thinking' : 'Show thinking'}
      </button>
      {open && (
        <div ref={bodyRef} className="text-[11px] font-sans text-white/55 italic whitespace-pre-wrap break-words mt-1 pl-3 border-l border-white/15 leading-snug">
          {thoughts}
        </div>
      )}
    </div>
  )
}

// ThinkingIndicator renders a Claude-Code-style "Ruminating…" line with
// pulsing dots and a live elapsed timer. Visible while the agent is busy
// but hasn't yet streamed any assistant text for the current turn. When
// the agent has emitted thinking content (chain-of-thought), the
// indicator gets a `▶` toggle that expands the streaming thoughts inline
// so the indicator + thoughts disclosure are one combined row instead of
// two separate ones.
function ThinkingIndicator({ busySince, detail, thoughts }: { busySince?: string | null; detail?: string; thoughts?: string }) {
  const [, setTick] = useState(0)
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const iv = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(iv)
  }, [])
  useEffect(() => {
    if (open) bodyRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open])
  // detail comes from the canonical status pipeline — "thinking…" at the
  // start of a turn, then the active tool name (e.g. "Bash: ls -la") while
  // a tool runs. Fall back to "Ruminating…" if no detail yet.
  const verb = detail && detail !== '' && detail !== 'finished' ? detail : 'Ruminating'
  const elapsed = formatElapsed(busySince)
  const hasThoughts = !!thoughts && thoughts.trim() !== ''
  return (
    <div className="text-[12px] font-sans py-1">
      <div className="flex items-baseline gap-2 text-white/65 italic">
        <span className="thinking-dots">{verb}</span>
        {elapsed && <span className="text-white/40 not-italic font-mono text-[10px]">({elapsed})</span>}
        {hasThoughts && (
          <button
            onClick={() => setOpen(v => !v)}
            className="text-white/40 hover:text-white/70 not-italic text-[10px] flex items-center gap-1 transition-colors"
          >
            <span className="text-[8px]">{open ? '▼' : '▶'}</span>
            {open ? 'hide' : 'click to show'}
          </button>
        )}
      </div>
      {open && hasThoughts && (
        <div ref={bodyRef} className="text-[11px] font-sans text-white/55 italic whitespace-pre-wrap break-words mt-1 pl-3 border-l border-white/15 leading-snug">
          {thoughts}
        </div>
      )}
    </div>
  )
}

// inflightThoughts returns the streaming thoughts of the assistant entry
// currently being generated, so the ThinkingIndicator can disclose them
// inline. Returns "" if there's no in-progress assistant entry.
function inflightThoughts(entries: Entry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'user' || e.kind === 'permission' || e.kind === 'system') return ''
    if (e.kind === 'assistant') {
      // Only "in flight" if there's no visible text yet — once text streams,
      // the ThinkingIndicator vanishes and the assistant entry's own
      // disclosure takes over.
      return e.text ? '' : (e.thoughts || '')
    }
  }
  return ''
}

// Floating sprite in the bottom-right of the chat panel transcript area.
// 2x the normal card size (64px) with the same idle/busy/done animations.
function ChatPanelSprite({ sprite, state }: { sprite?: string; state?: string }) {
  const animClass = useSpriteAnimation(state || 'idle', true)
  if (!sprite) return null
  return (
    <div
      className={`absolute bottom-3 right-3 pointer-events-none ${animClass}`}
      style={{ width: 64, height: 64 }}
    >
      <img
        src={`/sprites/${sprite}.png`}
        alt=""
        style={{ imageRendering: 'pixelated', width: 64, height: 64, maxWidth: 'none', maxHeight: 'none', objectFit: 'contain' }}
      />
    </div>
  )
}

// ── Header dropdown ─────────────────────────────────────────

function ChatPanelDropdown({
  onSearch,
  onMenu,
  onCancel,
  onClose,
  searchOpen,
}: {
  onSearch: () => void
  onMenu: (e: React.MouseEvent) => void
  onCancel?: () => void
  onClose: () => void
  searchOpen: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[20px] text-white/60 hover:text-white px-1 py-0.5 leading-none"
        title="Actions"
      >⋯</button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 rounded-md overflow-hidden min-w-[140px]"
          style={{
            background: 'rgba(15, 25, 45, 0.95)',
            border: '1px solid rgba(255,255,255,0.15)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        >
          <button
            onClick={() => { onSearch(); setOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-white/80 hover:bg-white/10 flex items-center gap-2"
          >
            <span className="text-white/40">⌘F</span>
            <span>{searchOpen ? 'Close search' : 'Search'}</span>
          </button>
          {onCancel && (
            <button
              onClick={() => { onCancel(); setOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-accent-red/80 hover:bg-white/10 flex items-center gap-2"
            >
              <span className="text-white/40">⌃C</span>
              <span>Cancel</span>
            </button>
          )}
          <button
            onClick={(e) => { onMenu(e); setOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-white/80 hover:bg-white/10"
          >Agent menu…</button>
          <div className="border-t border-white/10" />
          <button
            onClick={() => { onClose(); setOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-white/60 hover:bg-white/10 flex items-center gap-2"
          >
            <span className="text-white/40">Esc</span>
            <span>Close panel</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ── Search ──────────────────────────────────────────────────

function countSearchMatches(entries: Entry[], query: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  let count = 0
  for (const e of entries) {
    const text = e.kind === 'tool' ? (e.data.title || e.data.kind || '') : ('text' in e ? e.text : '')
    if (!text) continue
    let idx = 0
    const lower = text.toLowerCase()
    while ((idx = lower.indexOf(q, idx)) !== -1) { count++; idx += q.length }
  }
  return count
}

function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query || !text) return <>{text}</>
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let last = 0
  let idx = lower.indexOf(q, 0)
  let key = 0
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx))
    parts.push(
      <mark key={key++} className="bg-accent-yellow/40 text-white rounded-sm px-px" data-search-match>
        {text.slice(idx, idx + query.length)}
      </mark>
    )
    last = idx + query.length
    idx = lower.indexOf(q, last)
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

function SearchBar({
  query,
  onQueryChange,
  matchCount,
  matchIdx,
  onNext,
  onPrev,
  onClose,
  inputRef,
}: {
  query: string
  onQueryChange: (q: string) => void
  matchCount: number
  matchIdx: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  return (
    <div
      className="absolute top-1 right-3 z-20 flex items-center gap-1 rounded-md px-2 py-1"
      style={{
        background: 'rgba(20, 30, 50, 0.95)',
        border: '1px solid rgba(255,255,255,0.15)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev(); else onNext()
            // Scroll to the current match
            const marks = document.querySelectorAll('[data-search-match]')
            const target = marks[e.shiftKey ? ((matchIdx - 1 + marks.length) % marks.length) : ((matchIdx + 1) % marks.length)]
            target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
          if (e.key === 'Escape') { e.stopPropagation(); onClose() }
        }}
        placeholder="Search…"
        className="bg-transparent text-[12px] font-sans text-white placeholder-white/30 outline-none w-40"
      />
      {query && (
        <span className="text-[10px] text-white/40 font-mono shrink-0">
          {matchCount > 0 ? `${matchIdx + 1}/${matchCount}` : '0/0'}
        </span>
      )}
      <button onClick={() => { onPrev(); scrollToMatch(matchIdx - 1, matchCount) }} className="text-white/50 hover:text-white text-[11px] px-0.5" title="Previous (Shift+Enter)">▲</button>
      <button onClick={() => { onNext(); scrollToMatch(matchIdx + 1, matchCount) }} className="text-white/50 hover:text-white text-[11px] px-0.5" title="Next (Enter)">▼</button>
      <button onClick={onClose} className="text-white/50 hover:text-white text-[11px] px-1" title="Close (Esc)">✕</button>
    </div>
  )
}

function scrollToMatch(idx: number, total: number) {
  if (total <= 0) return
  const wrapped = ((idx % total) + total) % total
  setTimeout(() => {
    const marks = document.querySelectorAll('[data-search-match]')
    marks[wrapped]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, 0)
}
