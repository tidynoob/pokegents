import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AgentState } from '../types'
import { fetchTranscript, TranscriptEntry, setSprite, fetchProjectList, fetchRoleList, ProjectInfo, RoleInfo } from '../api'
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
import { useAgentRename } from '../hooks/useAgentRename'
import {
  BgShell,
  extractTaskId,
  isBackgroundSpawn,
  isAgentSpawn,
  isMonitorSpawn,
  extractBgLabel,
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

type DeliveryState = 'sending' | 'confirmed' | 'failed' | 'queued'

type Entry =
  | { kind: 'user'; id: string; text: string; ts?: number; nonce?: string; deliveryState?: DeliveryState }
  | { kind: 'assistant'; id: string; text: string; thoughts: string; ts?: number }
  | { kind: 'tool'; id: string; data: ToolCall; ts?: number }
  | { kind: 'system'; id: string; text: string; ts?: number }
  | { kind: 'permission'; id: string; requestId: number; toolCall?: ToolCall; options: PermissionOption[]; resolved?: 'allowed' | 'denied' | 'pending'; ts?: number }

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
  const rename = useAgentRename(agent.session_id, agent.display_name || '')
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const turnIdRef = useRef(0)
  // Queued messages: prompts the user typed while the agent was busy.
  // Held locally — NOT sent to the server until the current turn finishes.
  // Follows the Zed pattern: one prompt in flight at a time, queue in UI.
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])
  // Phase 5: sseBusy removed — agent.state (from dashboard SSE via
  // publishAgentStatePatch) is now the single source of truth for busy.
  const allCaps = useRuntimeCapabilities()
  const caps = capsFor(allCaps, agent.interface)

  // Timestamps: false | true | 'debug' (debug shows table borders)
  const [showTimestamps, setShowTimestamps] = useState<boolean | 'debug'>(() => localStorage.getItem('pokegents-show-timestamps') !== 'false')

  // Debug panel
  const [debugOpen, setDebugOpen] = useState(false)
  const debugLogRef = useRef<string[]>([])
  const sseReconnectRef = useRef<(() => void) | null>(null)
  const addDebugLog = useCallback((msg: string) => {
    debugLogRef.current = [...debugLogRef.current.slice(-99), `${new Date().toLocaleTimeString()} ${msg}`]
  }, [])

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
    if (rename.isRenaming) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [rename.isRenaming])

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

  const isBusy = agent.state === 'busy'
  const busySinceTs = agent.busy_since
  const bgToolIds = useMemo(() => new Set(bgShells.keys()), [bgShells])
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
          : 'idle'

  // Reset transcript when switching agents.
  useEffect(() => {
    setEntries([])
    setStreamReady(false)
    setTitle('')
    setQueuedMessages([])
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
      // Background tasks are tracked via live claude/task_started and
      // claude/task_notification SSE events from our ACP patch — no
      // transcript scanning needed.
    }).catch(() => { /* no transcript yet — fine */ })
    return () => { cancelled = true }
  }, [agent.session_id])

  // SSE subscription with auto-reconnect. Browser's native EventSource
  // gives up on non-200 (e.g. 404 during a brief cancel/restart window).
  // We wrap it so transient 404s don't permanently kill the stream.
  useEffect(() => {
    if (!pokegentId) return
    let closed = false
    let currentEs: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let lastEventAt = Date.now()
    let healthTimer: ReturnType<typeof setInterval> | null = null

    function touch() { lastEventAt = Date.now() }

    function connect() {
      if (closed) return
      if (healthTimer) clearInterval(healthTimer)
      const es = new EventSource(`/api/chat/${pokegentId}/stream`)
      currentEs = es

      es.onopen = () => {
        touch()
        addDebugLog('SSE: connected')
        setStreamReady(true)
        const rc = reconfigureRef.current
        if (rc && Date.now() < rc.endsAt) {
          if (rc.pendingMsg) {
            appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: rc.pendingMsg })
          }
          reconfigureRef.current = null
          setReconfiguring(false)
        }
      }

      es.addEventListener('heartbeat', () => { touch() })
      es.addEventListener('session_update', (e) => {
        touch()
        try {
          const env = JSON.parse((e as MessageEvent).data) as SessionUpdateEnvelope
          applyUpdate(env.update)
        } catch (err) { console.warn('chat: bad session_update', err) }
      })
      es.addEventListener('permission_request', (e) => {
        touch()
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
      es.addEventListener('state', (e) => {
        touch()
        try {
          const data = JSON.parse((e as MessageEvent).data) as { state?: string }
          addDebugLog(`SSE state: ${data?.state}`)
          if (data?.state === 'idle') {
            setQueuedMessages(prev => {
              if (prev.length === 0) return prev
              const [next, ...rest] = prev
              // Transition the queued entry to 'sending' if it exists, otherwise append fresh.
              const queuedNonce = crypto.randomUUID()
              setEntries(ents => {
                // Find the first queued user entry matching this text and promote it.
                const idx = ents.findIndex(e => e.kind === 'user' && e.deliveryState === 'queued' && e.text === next)
                if (idx >= 0) {
                  const copy = [...ents]
                  copy[idx] = { ...copy[idx], deliveryState: 'sending', nonce: queuedNonce } as Entry
                  return copy
                }
                return [...ents, { kind: 'user', id: `u-${turnIdRef.current++}`, text: next, nonce: queuedNonce, deliveryState: 'sending', ts: Date.now() }]
              })
              fetch(`/api/sessions/${pokegentId}/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: next, nonce: queuedNonce }),
              }).then(r => {
                updateDeliveryState(queuedNonce, r.ok ? 'confirmed' : 'failed')
              }).catch(() => {
                updateDeliveryState(queuedNonce, 'failed')
              })
              return rest
            })
          }
        } catch { /* ignore */ }
      })
      es.addEventListener('exit', () => {
        touch()
        const rc = reconfigureRef.current
        const intentional = rc && Date.now() < rc.endsAt
        if (!intentional) {
          appendEntry({ kind: 'system', id: `exit-${turnIdRef.current++}`, text: 'Chat process exited.' })
        }
        setStreamReady(false)
      })
      // Claude SDK extension events forwarded by our ACP patch.
      es.addEventListener('claude/task_started', (e) => {
        touch()
        try {
          const d = JSON.parse((e as MessageEvent).data)
          setBgShells(prev => {
            if (prev.has(d.taskId)) return prev
            const out = new Map(prev)
            out.set(d.taskId, {
              taskId: d.taskId,
              command: d.description || d.workflowName || 'background task',
              startedAt: Date.now(),
              status: 'running',
              type: d.taskType === 'local_bash' ? 'shell' : 'agent',
            })
            return out
          })
        } catch {}
      })
      es.addEventListener('claude/task_notification', (e) => {
        touch()
        try {
          const d = JSON.parse((e as MessageEvent).data)
          setBgShells(prev => {
            const cur = prev.get(d.taskId)
            if (!cur) return prev
            const out = new Map(prev)
            const status = d.status === 'completed' ? 'completed' : d.status === 'stopped' ? 'killed' : 'failed'
            out.set(d.taskId, { ...cur, status, endedAt: Date.now(), lastOutput: d.summary })
            return out
          })
        } catch {}
      })
      es.addEventListener('claude/task_progress', (e) => {
        touch()
        try {
          const d = JSON.parse((e as MessageEvent).data)
          setBgShells(prev => {
            const cur = prev.get(d.taskId)
            if (!cur) return prev
            const out = new Map(prev)
            out.set(d.taskId, { ...cur, lastOutput: d.summary || d.description })
            return out
          })
        } catch {}
      })
      es.addEventListener('claude/api_retry', (e) => {
        touch()
        try {
          const d = JSON.parse((e as MessageEvent).data)
          appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: `API retry ${d.attempt}/${d.maxRetries} (${d.error || 'unknown'}) — waiting ${Math.round((d.retryDelayMs || 0) / 1000)}s` })
        } catch {}
      })
      es.addEventListener('claude/rate_limit', (e) => {
        touch()
        try {
          const d = JSON.parse((e as MessageEvent).data)
          const info = d.rateLimitInfo
          if (info?.status === 'rejected' || info?.status === 'allowed_warning') {
            const pct = info.utilization != null ? `${Math.round(info.utilization * 100)}%` : ''
            let resetStr = ''
            if (info.resetsAt) {
              const resetsMs = new Date(info.resetsAt).getTime() - Date.now()
              resetStr = resetsMs > 0 ? ` — resets in ${Math.ceil(resetsMs / 60000)}m` : ' — resets soon'
            }
            appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: `Rate limit ${info.status === 'rejected' ? 'hit' : 'warning'} ${pct}${resetStr}` })
          }
        } catch {}
      })
      es.onerror = () => {
        addDebugLog(`SSE error: readyState=${es.readyState}`)
        if (es.readyState === EventSource.CLOSED) {
          setStreamReady(false)
          es.close()
          if (!closed) {
            addDebugLog('SSE: retrying in 2s')
            retryTimer = setTimeout(connect, 2000)
          }
        }
      }

      healthTimer = setInterval(() => {
        if (Date.now() - lastEventAt > 35_000 && es.readyState !== EventSource.CLOSED) {
          addDebugLog('SSE: heartbeat timeout, reconnecting')
          es.close()
          setStreamReady(false)
          if (!closed) {
            retryTimer = setTimeout(connect, 500)
          }
        }
      }, 10_000)
    }

    connect()

    sseReconnectRef.current = () => {
      addDebugLog('SSE: manual reconnect')
      currentEs?.close()
      if (retryTimer) clearTimeout(retryTimer)
      if (healthTimer) clearInterval(healthTimer)
      connect()
    }

    return () => {
      closed = true
      sseReconnectRef.current = null
      if (retryTimer) clearTimeout(retryTimer)
      if (healthTimer) clearInterval(healthTimer)
      currentEs?.close()
    }
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
      if (e.key === 'c' && (e.ctrlKey || e.metaKey) && isBusy) {
        if (window.getSelection()?.toString()) return // don't hijack copy
        e.preventDefault()
        cancel()
        appendEntry({ kind: 'system', id: `s-${turnIdRef.current++}`, text: 'Interrupted. What would you like me to do?' })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, isBusy, searchOpen])

  function appendEntry(e: Entry) { setEntries(prev => [...prev, { ...e, ts: e.ts || Date.now() }]) }

  function updateDeliveryState(nonce: string, state: DeliveryState) {
    setEntries(prev => prev.map(e =>
      e.kind === 'user' && e.nonce === nonce
        ? { ...e, deliveryState: state }
        : e
    ))
  }

  async function retryMessage(entry: Entry) {
    if (entry.kind !== 'user' || !entry.nonce) return
    updateDeliveryState(entry.nonce, 'sending')
    try {
      const r = await fetch(`/api/sessions/${pokegentId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: entry.text, nonce: entry.nonce }),
      })
      updateDeliveryState(entry.nonce, r.ok ? 'confirmed' : 'failed')
    } catch {
      updateDeliveryState(entry.nonce, 'failed')
    }
  }

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
            next.push({ kind: 'assistant', id: `a-${turnIdRef.current++}`, text: t, thoughts: '', ts: Date.now() })
          }
          return next
        }
        case 'agent_thought_chunk': {
          const t = textOf((u as { content: ContentBlock }).content)
          if (last && last.kind === 'assistant') {
            next[next.length - 1] = { ...last, thoughts: last.thoughts + t }
          } else {
            next.push({ kind: 'assistant', id: `a-${turnIdRef.current++}`, text: '', thoughts: t, ts: Date.now() })
          }
          return next
        }
        case 'user_message_chunk': {
          // Synthetic event emitted server-side by ChatSession.Prompt so
          // prompts sent from anywhere (ChatPanel here, AgentCard's
          // QuickInput, future API consumers) appear in the transcript.
          // Nonce de-dup: if the event carries a nonce matching an existing
          // optimistic entry, skip it — the local entry already covers it.
          const echoNonce = (u as { nonce?: string }).nonce
          if (echoNonce && next.some(e => e.kind === 'user' && e.nonce === echoNonce)) {
            return next
          }
          // ChatPanel.submitText also appends the user message locally for
          // instant feedback, so de-dup here: if the last entry is already
          // a user message with the same text, skip — that's our own echo.
          // Otherwise (prompt sent from AgentCard while panel is open)
          // push a new user entry.
          const ut = textOf((u as { content: ContentBlock }).content)
          if (last && last.kind === 'user' && last.text === ut) {
            return next
          }
          next.push({ kind: 'user', id: `u-${turnIdRef.current++}`, text: ut, ts: Date.now() })
          return next
        }
        case 'tool_call': {
          const tc = u as unknown as ToolCall
          if (isBackgroundSpawn(tc.kind, tc.rawInput)) {
            pendingSpawnRef.current.set(tc.toolCallId, extractBashCommand(tc.rawInput))
          }
          // Agent subagent spawns run in the background — track immediately
          if (isAgentSpawn(tc.title, tc.rawInput, tc.kind)) {
            const label = extractBgLabel(tc.title, tc.rawInput)
            setBgShells(prev => {
              if (prev.has(tc.toolCallId)) return prev
              const out = new Map(prev)
              out.set(tc.toolCallId, { taskId: tc.toolCallId, command: label, startedAt: Date.now(), status: 'running', type: 'agent' })
              return out
            })
          }
          // Monitor tool calls are long-running watchers
          if (isMonitorSpawn(tc.title, tc.kind)) {
            const label = extractBgLabel(tc.title, tc.rawInput)
            setBgShells(prev => {
              if (prev.has(tc.toolCallId)) return prev
              const out = new Map(prev)
              out.set(tc.toolCallId, { taskId: tc.toolCallId, command: label, startedAt: Date.now(), status: 'running', type: 'monitor' })
              return out
            })
          }
          next.push({ kind: 'tool', id: tc.toolCallId, data: tc, ts: Date.now() })
          return next
        }
        case 'tool_call_update': {
          const tc = u as unknown as ToolCall
          // Background-shell spawn detection: rawInput arrives empty on
          // the initial tool_call event — the real data only shows up in
          // tool_call_update. Check here so we actually catch it.
          if (!pendingSpawnRef.current.has(tc.toolCallId) && isBackgroundSpawn(tc.kind, tc.rawInput)) {
            pendingSpawnRef.current.set(tc.toolCallId, extractBashCommand(tc.rawInput))
          }
          // Agent/Monitor detection on update (rawInput arrives here, not on initial tool_call)
          if (!bgShells.has(tc.toolCallId) && isAgentSpawn(tc.title, tc.rawInput, tc.kind)) {
            const label = extractBgLabel(tc.title, tc.rawInput)
            setBgShells(prev => {
              if (prev.has(tc.toolCallId)) return prev
              const out = new Map(prev)
              out.set(tc.toolCallId, { taskId: tc.toolCallId, command: label, startedAt: Date.now(), status: 'running', type: 'agent' })
              return out
            })
          }
          if (!bgShells.has(tc.toolCallId) && isMonitorSpawn(tc.title, tc.kind)) {
            const label = extractBgLabel(tc.title, tc.rawInput)
            setBgShells(prev => {
              if (prev.has(tc.toolCallId)) return prev
              const out = new Map(prev)
              out.set(tc.toolCallId, { taskId: tc.toolCallId, command: label, startedAt: Date.now(), status: 'running', type: 'monitor' })
              return out
            })
          }
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
          // Agent/Monitor completion: update bgShells when these finish.
          if ((tc.status === 'completed' || tc.status === 'failed') && bgShells.has(tc.toolCallId)) {
            const text = readToolText(tc.content) || (typeof tc.rawOutput === 'string' ? tc.rawOutput : '')
            setBgShells(prev => {
              const cur = prev.get(tc.toolCallId)
              if (!cur || cur.status !== 'running') return prev
              const out = new Map(prev)
              out.set(tc.toolCallId, { ...cur, status: tc.status === 'completed' ? 'completed' : 'failed', endedAt: Date.now(), lastOutput: text ? text.slice(0, 200) : cur.lastOutput })
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
            // with status/rawOutput but content=[]. Intermediary events may
            // carry null for fields that were populated in earlier events.
            const merged = { ...cur.data } as Record<string, unknown>
            for (const [k, v] of Object.entries(tc)) {
              if (k === 'sessionUpdate') continue
              // Skip null/undefined — never clobber existing data with nothing.
              if (v === undefined || v === null) continue
              // Skip empty arrays when we already have populated arrays.
              if (Array.isArray(v) && v.length === 0 && Array.isArray(merged[k]) && (merged[k] as unknown[]).length > 0) continue
              // Skip empty objects when we already have populated objects.
              if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 && merged[k] != null && typeof merged[k] === 'object' && Object.keys(merged[k] as object).length > 0) continue
              merged[k] = v
            }
            next[idx] = { ...cur, data: merged as unknown as ToolCall }
          } else {
            next.push({ kind: 'tool', id: tc.toolCallId, data: tc, ts: Date.now() })
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
    const nonce = crypto.randomUUID()
    if (isBusy) {
      // Agent is busy — show optimistic entry as queued, then queue locally.
      // The SSE state:idle handler will pop and send when the turn finishes.
      appendEntry({ kind: 'user', id: `u-${turnIdRef.current++}`, text, nonce, deliveryState: 'queued' })
      setQueuedMessages(prev => [...prev, text])
      return
    }
    // Not busy — optimistic append with 'sending', POST in background.
    appendEntry({ kind: 'user', id: `u-${turnIdRef.current++}`, text, nonce, deliveryState: 'sending' })
    try {
      const r = await fetch(`/api/sessions/${pokegentId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, nonce }),
      })
      if (r.ok) {
        updateDeliveryState(nonce, 'confirmed')
      } else {
        updateDeliveryState(nonce, 'failed')
        const msg = await r.text()
        appendEntry({ kind: 'system', id: `e-${turnIdRef.current++}`, text: `Error: ${msg}` })
      }
    } catch (err) {
      updateDeliveryState(nonce, 'failed')
      appendEntry({ kind: 'system', id: `e-${turnIdRef.current++}`, text: `Error: ${String(err)}` })
    }
  }

  async function cancel() {
    if (!pokegentId) return
    // Promote any in-progress bash tool call to a background shell.
    // The SDK doesn't kill the process on cancel — it continues running,
    // same as Ctrl+B in the Claude Code terminal.
    setEntries(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const e = prev[i]
        if (e.kind === 'tool' && e.data.kind === 'execute' && e.data.status !== 'completed' && e.data.status !== 'failed') {
          const cmd = extractBashCommand(e.data.rawInput) || e.data.title || 'background task'
          const taskId = e.data.toolCallId
          setBgShells(p => {
            if (p.has(taskId)) return p
            const out = new Map(p)
            out.set(taskId, { taskId, command: cmd, startedAt: Date.now(), status: 'running' })
            return out
          })
          break
        }
      }
      return prev
    })
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
      className="h-full w-full flex flex-col gba-card overflow-visible"
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
            className="cursor-pointer hover:brightness-125 relative shrink-0 overflow-visible"
            style={{ width: 32, height: 32 }}
          >
            <div className="absolute inset-0 bg-black/20 rounded-lg" />
            <div className={`relative ${useSpriteAnimation(agent.state || 'idle', true)}`}>
              <CreatureIcon sessionId={agent.session_id} size={32} noGlow={false} doneFlash={false} spriteOverride={agent.sprite} noBg />
              <BusyBubble isBusy={isBusy} />
              <DoneBubble isDone={false} />
            </div>
          </div>
          {/* Name + HP bar */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                {rename.isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={rename.newName}
                    onChange={(e) => rename.setNewName(e.target.value)}
                    onBlur={rename.submitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename.submitRename()
                      if (e.key === 'Escape') rename.cancelRename()
                    }}
                    className="text-[8px] font-pixel text-white bg-transparent border-b border-white/50 outline-none w-full pixel-shadow"
                  />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <h3
                      className="text-[8px] font-pixel text-white truncate cursor-pointer hover:text-accent-yellow pixel-shadow uppercase"
                      onClick={() => rename.startRename()}
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
            onDebug={() => setDebugOpen(true)}
            showTimestamps={showTimestamps}
            onToggleTimestamps={() => {
              const next = !showTimestamps
              setShowTimestamps(next)
              localStorage.setItem('pokegents-show-timestamps', String(next))
            }}
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
          className="h-full overflow-y-auto overflow-x-hidden rounded-md px-3 pt-2.5 pb-10 space-y-1.5 font-mono"
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
          {entries.map(e => <EntryRow key={e.id} entry={e} onDecidePermission={decidePermission} onRetry={retryMessage} searchQuery={searchQuery} backgroundedToolIds={bgToolIds} showTimestamps={showTimestamps} />)}
          {/* Sentinel "Thinking..." row — visible while the agent is busy
              AND we haven't received any assistant-message-chunk *text* for
              this turn yet (disappears as soon as text starts streaming).
              While only thoughts are streaming, the indicator owns them
              behind a click-to-expand toggle so the user sees one row
              instead of two.
              Hidden when the last entry is an active tool call — the
              ToolCallRow already shows its own elapsed timer, and having
              both reads as two conflicting clocks (turn-level vs tool-level). */}
          {isBusy && (() => {
            const lastEntry = entries[entries.length - 1]
            const lastIsActiveTool = lastEntry?.kind === 'tool' &&
              (lastEntry.data.status === 'pending' || lastEntry.data.status === 'in_progress')
            if (lastIsActiveTool) return null
            if (lastEntryIsCurrentAssistantMessage(entries)) return null
            const indicator = (
              <ThinkingIndicator
                busySince={busySinceTs}
                thoughts={inflightThoughts(entries)}
              />
            )
            if (!showTimestamps) return indicator
            return (
              <table className="w-full border-collapse"><tbody><tr>
                <td className={`align-top w-0 whitespace-nowrap pr-1 ${showTimestamps === 'debug' ? 'border border-red-500/30' : ''}`}>
                  <span className="text-[8px] font-mono text-white/20 tabular-nums select-none">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
                </td>
                <td className={`align-top ${showTimestamps === 'debug' ? 'border border-blue-500/30' : ''}`}>
                  {indicator}
                </td>
              </tr></tbody></table>
            )
          })()}
        </div>
        {/* Floating sprite — bottom-right of transcript, 2x size */}
        <ChatPanelSprite sprite={agent.sprite} state={agent.state} />
      </div>

      {/* Queued messages — stacked above input, same visual treatment */}
      {queuedMessages.length > 0 && (
        <div className="shrink-0 px-2 pt-1.5 space-y-1">
          <div className="flex items-center gap-2 px-0.5">
            <span className="text-[9px] font-mono text-white/30">
              {queuedMessages.length} queued
            </span>
            <div className="flex-1 h-px bg-white/10" />
            <button
              type="button"
              onClick={() => setQueuedMessages([])}
              className="text-[9px] font-mono text-white/30 hover:text-white/60 transition-colors"
            >clear</button>
          </div>
          {queuedMessages.map((msg, i) => (
            <div key={i} className="flex items-start gap-1">
              <div className="flex-1 gba-dialog-dark text-[10px] leading-[14px] font-mono px-2.5 py-1 text-white/40 truncate">
                {msg}
              </div>
              <button
                type="button"
                onClick={() => setQueuedMessages(prev => prev.filter((_, j) => j !== i))}
                className="text-[9px] text-white/20 hover:text-white/50 transition-colors px-1 pt-0.5"
              >x</button>
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
          onRename={() => { setMenuOpen(false); rename.startRename() }}
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
      {debugOpen && createPortal(
        <DebugModal
          agent={agent}
          pokegentId={pokegentId}
          streamReady={streamReady}
          queuedMessages={queuedMessages}
          bgShells={bgShells}
          debugLog={debugLogRef.current}
          onClose={() => setDebugOpen(false)}
          onForceIdle={async () => {
            await fetch(`/api/sessions/${pokegentId}/debug/force-idle`, { method: 'POST' })
            addDebugLog('action: force idle')
          }}
          onRespawnAcp={async () => {
            addDebugLog('action: respawn ACP')
            await fetch(`/api/sessions/${pokegentId}/debug/respawn`, { method: 'POST' })
          }}
          onReconnectSse={() => {
            sseReconnectRef.current?.()
          }}
          onReloadTranscript={() => {
            if (!agent.session_id) return
            addDebugLog('action: reload transcript')
            fetchTranscript(agent.session_id, 5000).then(page => {
              const seeded = entriesFromTranscript(page.entries || [])
              if (seeded.length > 0) {
                setEntries(seeded)
                turnIdRef.current = seeded.length
              }
              addDebugLog(`transcript: ${seeded.length} entries loaded`)
            }).catch(() => {})
          }}
          onFlushQueue={() => {
            addDebugLog(`action: flushed ${queuedMessages.length} queued messages`)
            setQueuedMessages([])
          }}
          onClearBgTasks={() => {
            addDebugLog('action: cleared bg tasks')
            setBgShells(new Map())
          }}
          showTimestamps={showTimestamps}
          onToggleDebugBorders={() => {
            setShowTimestamps(prev => prev === 'debug' ? true : 'debug')
          }}
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
    const ts = t.timestamp ? new Date(t.timestamp).getTime() : undefined
    if (t.type === 'user' && t.content) {
      if (isLocalCommandArtifact(t.content)) continue
      out.push({ kind: 'user', id: id('u'), text: t.content, ts })
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
      if (text || thoughts) out.push({ kind: 'assistant', id: id('a'), text, thoughts, ts })
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.name) {
          const toolId = b.id || ''
          let title = b.name
          let rawInput: unknown = undefined
          try {
            const inputStr = b.input || '{}'
            const parsed = JSON.parse(inputStr)
            rawInput = parsed
            if (parsed.command) title = `${b.name}: ${parsed.command.slice(0, 60)}`
            else if (parsed.file_path) title = `${b.name}: ${parsed.file_path}`
            else if (parsed.pattern) title = `${b.name}: ${parsed.pattern}`
          } catch {
            // Truncated JSON (server caps at 200 chars + "...") — show raw string
            if (b.input && b.input.length > 2) rawInput = b.input
          }
          const result = toolResults.get(toolId)
          out.push({
            kind: 'tool',
            id: id('t'),
            ts,
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
  onRetry,
  searchQuery,
  backgroundedToolIds,
  showTimestamps,
}: {
  entry: Entry
  onDecidePermission: (requestId: number, optionId: string, cancelled: boolean) => void
  onRetry?: (entry: Entry) => void
  searchQuery?: string
  backgroundedToolIds?: Set<string>
  showTimestamps?: boolean | 'debug'
}) {
  const tsLabel = entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : ''

  const content = (() => {
    switch (entry.kind) {
      case 'user': {
        const taskMatch = entry.text.match(/<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/task-notification>/)
        if (taskMatch) {
          return <TaskNotificationRow text={entry.text} summary={taskMatch[1].trim()} />
        }
        if (isLocalCommandArtifact(entry.text)) return null
        const ds = entry.deliveryState
        const borderClass = ds === 'failed'
          ? 'border-l-2 border-red-500'
          : ds === 'queued'
            ? 'border-l-2 border-amber-500'
            : 'border-l-2 border-amber-400/70'
        const opacityClass = ds === 'sending' || ds === 'queued' ? 'opacity-50' : ''
        return (
          <div className={`pt-4 ${opacityClass}`} data-user-entry>
            <div
              className={`rounded-md px-2.5 py-2 text-[11px] font-mono text-white whitespace-pre-wrap break-words leading-snug ${borderClass}`}
              style={{ background: 'rgba(180, 130, 40, 0.12)' }}
            >
              <span className="text-amber-300/70 mr-1">&gt;</span><HighlightText text={entry.text} query={searchQuery} />
              {ds === 'failed' && onRetry && (
                <button
                  type="button"
                  onClick={() => onRetry(entry)}
                  className="ml-2 text-[9px] font-pixel text-red-400 hover:text-red-300 transition-colors"
                >retry</button>
              )}
            </div>
          </div>
        )
      }
      case 'assistant': {
        if (!entry.text && !entry.thoughts) return null
        if (!entry.text) return null
        return (
          <div className="text-[11px] font-mono text-white/95 leading-snug">
            {entry.thoughts && <ThoughtsDisclosure thoughts={entry.thoughts} />}
            <TypewriterMarkdown text={entry.text} />
          </div>
        )
      }
      case 'tool':
        return <ToolCallRow entry={entry} backgrounded={backgroundedToolIds?.has(entry.id)} />
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
  })()

  if (!content) return null
  if (!showTimestamps) return content

  return (
    <table className="w-full border-collapse"><tbody><tr>
      <td className={`align-top w-0 whitespace-nowrap pr-1 ${showTimestamps === 'debug' ? 'border border-red-500/30' : ''}`}>
        <span className="text-[8px] font-mono text-white/20 tabular-nums select-none">{tsLabel}</span>
      </td>
      <td className={`align-top ${showTimestamps === 'debug' ? 'border border-blue-500/30' : ''}`}>
        {content}
      </td>
    </tr></tbody></table>
  )
}

// Expandable tool-call row with a tinted background so it reads as a
// distinct "event" block between assistant prose. Click the header to
// toggle the detail pane (locations, raw input/output when available).
function extractFilePath(text: string): string | null {
  const m = text.match(/(\/(?:Users|private|tmp|home|var|opt)\/\S+\.\w+)/)
  return m ? m[1] : null
}

function AnimatedDots() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setCount(c => (c + 1) % 4), 500)
    return () => clearInterval(iv)
  }, [])
  return <span className="inline-block w-[1.5em] text-left">{'.'.repeat(count)}</span>
}

function ToolCallRow({ entry, backgrounded }: { entry: Extract<Entry, { kind: 'tool' }>; backgrounded?: boolean }) {
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

  // Extract tool-specific display info
  const inp = t.rawInput && typeof t.rawInput === 'object' ? t.rawInput as Record<string, unknown> : null
  const toolName = (t as any)?._meta?.claudeCode?.toolName || t.kind || 'tool'
  const isEdit = toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit' || t.kind === 'edit'
  const isBash = toolName === 'Bash' || t.kind === 'execute'
  const isRead = toolName === 'Read' || t.kind === 'read'
  const isAgent = toolName === 'Agent' || t.kind === 'think'

  const filePath = inp?.file_path as string || inp?.path as string || inp?.notebook_path as string || ''
  const shortPath = filePath ? filePath.replace(/.*\/Projects\//, '').replace(/.*\/node_modules\//, 'node_modules/') : ''
  const bashCmd = inp?.command as string || (isBash && t.title && t.title !== 'Terminal' ? t.title : '')
  const bashDesc = inp?.description as string || ''
  const agentDesc = inp?.description as string || inp?.prompt as string || ''

  // Extract summary text from content/rawOutput, stripping markdown fences
  const summaryText = (() => {
    let raw = ''
    if (t.content && Array.isArray(t.content)) {
      for (const item of t.content as any[]) {
        if (item?.type === 'content' && item?.content?.type === 'text') { raw = item.content.text as string; break }
        if (item?.type === 'terminal' && item?.terminalOutput) { raw = item.terminalOutput as string; break }
      }
    }
    if (!raw && typeof t.rawOutput === 'string') raw = t.rawOutput
    // Strip markdown code fences (```console\n...\n```)
    raw = raw.replace(/^```\w*\n?/gm, '').replace(/\n?```$/gm, '').trim()
    return raw
  })()
  const truncSummary = summaryText.length > 200 ? summaryText.slice(0, 200) + '…' : summaryText

  // Diff detection — check ACP _meta toolResponse, rawInput, and rawOutput
  const toolResp = (t as any)?._meta?.claudeCode?.toolResponse
  const diffOld = toolResp?.oldString as string || toolResp?.old_string as string || inp?.old_string as string || inp?.oldString as string || undefined
  const diffNew = toolResp?.newString as string || toolResp?.new_string as string || inp?.new_string as string || inp?.newString as string || undefined
  const diffFile = toolResp?.filePath as string || toolResp?.file_path as string || ''
  const hasDiff = isEdit && diffOld != null && diffNew != null
  const editPath = shortPath || (diffFile ? diffFile.replace(/.*\/Projects\//, '') : '')

  const editSummary = (() => {
    if (!isEdit) return null
    if (hasDiff) {
      const oldLines = (diffOld || '').split('\n').length
      const newLines = (diffNew || '').split('\n').length
      const added = Math.max(0, newLines - oldLines)
      const removed = Math.max(0, oldLines - newLines)
      const changed = Math.min(oldLines, newLines)
      const parts: string[] = []
      if (added > 0) parts.push(`Added ${added} lines`)
      if (removed > 0) parts.push(`Removed ${removed} lines`)
      if (parts.length === 0) parts.push(`Changed ${changed} lines`)
      return parts.join(', ')
    }
    if (summaryText) return summaryText.split('\n')[0].slice(0, 80)
    return status === 'completed' ? 'Updated' : null
  })()

  // Header label
  const headerLabel = (() => {
    if (isBash) return 'Bash'
    if (toolName === 'NotebookEdit') return 'Notebook'
    if (isEdit) return 'Update'
    if (isRead) return 'Read'
    if (isAgent) return 'Agent'
    if (toolName === 'Write') return 'Write'
    if (toolName === 'Grep' || toolName === 'Glob') return toolName
    return toolName
  })()

  // Header detail
  const headerDetail = (() => {
    if (isBash && bashCmd) return bashCmd.length > 80 ? bashCmd.slice(0, 80) + '…' : bashCmd
    if (isEdit && editPath) return editPath
    if (isRead && shortPath) return shortPath
    if (isAgent && agentDesc) return agentDesc.length > 60 ? agentDesc.slice(0, 60) + '…' : agentDesc
    if (t.title && t.title !== t.kind && t.title !== 'Terminal') return t.title
    return ''
  })()

  return (
    <div
      className="rounded-md text-[11px] font-mono leading-snug"
      style={{ background: isRunning ? 'rgba(255, 200, 60, 0.04)' : 'rgba(255,255,255,0.03)' }}
    >
      {/* Header */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-2.5 py-1.5 hover:bg-white/5 transition-colors rounded-md"
      >
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
          <span className="text-white/90 font-semibold shrink-0">{headerLabel}</span>
          {headerDetail && (() => {
            const linkPath = filePath && (isEdit || isRead) ? filePath : extractFilePath(headerDetail)
            if (linkPath) {
              return (
                <a
                  href={`vscode://file${linkPath}`}
                  onClick={e => e.stopPropagation()}
                  className="text-white/45 truncate flex-1 hover:text-accent-blue hover:underline"
                  title={linkPath}
                >({headerDetail})</a>
              )
            }
            return <span className="text-white/45 truncate flex-1">({headerDetail})</span>
          })()}
          <span className="text-[9px] text-white/30 shrink-0 ml-auto">{open ? '▼' : '▶'}</span>
        </div>
        {/* Inline summary — always visible */}
        {isEdit && editSummary && (
          <div className="mt-0.5 ml-4 text-[10px] text-white/40">{editSummary}</div>
        )}
        {isBash && bashDesc && (
          <div className="mt-0.5 ml-4 text-[10px] text-white/40">{bashDesc}</div>
        )}
      </button>

      {/* Inline diff preview for edits — shown without expanding */}
      {isEdit && hasDiff && !open && (
        <div className="px-2.5 pb-1.5 ml-2">
          <pre className="text-[10px] font-mono bg-black/30 rounded px-2 py-1 max-h-24 overflow-hidden whitespace-pre-wrap break-all">
            {(() => {
              const lines: { text: string; type: '+' | '-' | ' ' }[] = []
              const oldLines = (diffOld || '').split('\n')
              const newLines = (diffNew || '').split('\n')
              for (const l of oldLines.slice(0, 4)) lines.push({ text: l, type: '-' })
              for (const l of newLines.slice(0, 4)) lines.push({ text: l, type: '+' })
              return lines.slice(0, 8).map((l, i) => (
                <div key={i} className={l.type === '+' ? 'text-green-400/80 bg-green-400/5' : l.type === '-' ? 'text-red-400/70 bg-red-400/5' : 'text-white/40'}>
                  {l.type}{l.text}
                </div>
              ))
            })()}
            {((diffOld || '').split('\n').length + (diffNew || '').split('\n').length > 8) && (
              <div className="text-white/25 mt-0.5">… click to expand</div>
            )}
          </pre>
        </div>
      )}

      {/* Inline bash output preview — truncated, shown without expanding */}
      {isBash && truncSummary && !open && (
        <div className="px-2.5 pb-1.5 ml-2">
          <pre className="text-[10px] font-mono text-white/50 bg-black/30 rounded px-2 py-1 max-h-16 overflow-hidden whitespace-pre-wrap break-all">
            {truncSummary}
          </pre>
        </div>
      )}

      {/* Running indicator */}
      {isRunning && elapsedStr && (
        <div className={`px-2.5 pb-1.5 text-[11px] font-mono ${backgrounded ? 'text-blue-400/60' : 'text-accent-yellow/60'}`}>
          {backgrounded ? `↳ running in background · ${elapsedStr}` : <><AnimatedDots /> tool call in progress — {elapsedStr}</>}
        </div>
      )}
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
function ThinkingIndicator({ busySince, thoughts }: { busySince?: string | null; thoughts?: string }) {
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
  const verb = 'Thinking'
  const elapsed = formatElapsed(busySince)
  const hasThoughts = !!thoughts && thoughts.trim() !== ''
  return (
    <div className="text-[11px] font-mono">
      <div className="flex items-baseline gap-2 text-white/50 italic">
        <span className="thinking-dots">{verb}</span>
        {elapsed && <span className="text-white/30 not-italic text-[10px]">({elapsed})</span>}
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
  onDebug,
  showTimestamps,
  onToggleTimestamps,
}: {
  onSearch: () => void
  onMenu: (e: React.MouseEvent) => void
  onCancel?: () => void
  onClose: () => void
  searchOpen: boolean
  onDebug?: () => void
  showTimestamps?: boolean | 'debug'
  onToggleTimestamps?: () => void
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
          {onToggleTimestamps && (
            <button
              onClick={() => { onToggleTimestamps(); setOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-white/80 hover:bg-white/10 flex items-center gap-2"
            >
              <span className={`text-[9px] ${showTimestamps ? 'text-accent-green' : 'text-white/30'}`}>{showTimestamps ? '●' : '○'}</span>
              <span>Timestamps</span>
            </button>
          )}
          {onDebug && (
            <>
              <div className="border-t border-white/10" />
              <button
                onClick={() => { onDebug(); setOpen(false) }}
                className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-amber-400/70 hover:bg-white/10"
              >Debug panel</button>
            </>
          )}
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

// ── Debug modal ────────────────────────────────────────────

function DebugModal({
  agent, pokegentId, streamReady, queuedMessages, bgShells, debugLog,
  onClose, onForceIdle, onRespawnAcp, onReconnectSse, onReloadTranscript, onFlushQueue, onClearBgTasks,
  showTimestamps, onToggleDebugBorders,
}: {
  agent: AgentState
  pokegentId: string
  streamReady: boolean
  queuedMessages: string[]
  bgShells: Map<string, BgShell>
  debugLog: string[]
  onClose: () => void
  onForceIdle: () => void
  onRespawnAcp: () => void
  onReconnectSse: () => void
  onReloadTranscript: () => void
  onFlushQueue: () => void
  onClearBgTasks: () => void
  showTimestamps?: boolean | 'debug'
  onToggleDebugBorders?: () => void
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(iv)
  }, [])

  const btnClass = "px-3 py-1.5 text-[11px] font-mono rounded hover:bg-white/10 transition-colors text-left"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative rounded-lg overflow-hidden w-[520px] max-h-[80vh] flex flex-col"
        style={{ background: 'rgba(15, 25, 45, 0.97)', border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
          <span className="text-[12px] font-mono text-amber-400/80">Debug — {agent.display_name || pokegentId.slice(0, 8)}</span>
          <button onClick={onClose} className="text-white/40 hover:text-white/80 text-[14px]">✕</button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4 text-[11px] font-mono">
          {/* State */}
          <div>
            <div className="text-white/30 text-[9px] uppercase tracking-wider mb-1.5">State</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-white/70">
              <span className="text-white/40">agent.state</span><span>{agent.state || '—'}</span>
              <span className="text-white/40">agent.detail</span><span className="truncate">{agent.detail || '—'}</span>
              <span className="text-white/40">isBusy</span><span className={agent.state === 'busy' ? 'text-accent-red' : 'text-accent-green'}>{String(agent.state === 'busy')}</span>
              <span className="text-white/40">streamReady</span><span className={streamReady ? 'text-accent-green' : 'text-accent-red'}>{String(streamReady)}</span>
              <span className="text-white/40">pokegentId</span><span className="truncate">{pokegentId}</span>
              <span className="text-white/40">sessionId</span><span className="truncate">{agent.session_id || '—'}</span>
              <span className="text-white/40">model</span><span>{agent.model || '—'}</span>
              <span className="text-white/40">context</span><span>{agent.context_tokens?.toLocaleString() || '?'} / {agent.context_window?.toLocaleString() || '?'}</span>
              <span className="text-white/40">interface</span><span>{agent.interface || '—'}</span>
              <span className="text-white/40">queued</span><span>{queuedMessages.length}</span>
              <span className="text-white/40">bgTasks</span><span>{bgShells.size} ({[...bgShells.values()].filter(s => s.status === 'running').length} running)</span>
            </div>
          </div>

          {/* Actions */}
          <div>
            <div className="text-white/30 text-[9px] uppercase tracking-wider mb-1.5">Actions</div>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={onForceIdle} className={`${btnClass} text-amber-400/80 border border-amber-400/20`}>
                Force idle
                <div className="text-[9px] text-white/30 mt-0.5">Override state to idle + broadcast idle</div>
              </button>
              <button onClick={onRespawnAcp} className={`${btnClass} text-amber-400/80 border border-amber-400/20`}>
                Respawn ACP
                <div className="text-[9px] text-white/30 mt-0.5">Kill + relaunch ACP subprocess</div>
              </button>
              <button onClick={onReconnectSse} className={`${btnClass} text-blue-400/80 border border-blue-400/20`}>
                Reconnect SSE
                <div className="text-[9px] text-white/30 mt-0.5">Force close + reopen event stream</div>
              </button>
              <button onClick={onReloadTranscript} className={`${btnClass} text-blue-400/80 border border-blue-400/20`}>
                Reload transcript
                <div className="text-[9px] text-white/30 mt-0.5">Re-fetch transcript from disk</div>
              </button>
              <button onClick={onFlushQueue} className={`${btnClass} text-white/60 border border-white/10`}>
                Flush queue ({queuedMessages.length})
                <div className="text-[9px] text-white/30 mt-0.5">Discard all queued messages</div>
              </button>
              <button onClick={onClearBgTasks} className={`${btnClass} text-white/60 border border-white/10`}>
                Clear bg tasks ({bgShells.size})
                <div className="text-[9px] text-white/30 mt-0.5">Reset background task list</div>
              </button>
              {onToggleDebugBorders && (
                <button onClick={onToggleDebugBorders} className={`${btnClass} ${showTimestamps === 'debug' ? 'text-red-400/80 border border-red-400/30' : 'text-white/60 border border-white/10'}`}>
                  {showTimestamps === 'debug' ? 'Hide' : 'Show'} layout borders
                  <div className="text-[9px] text-white/30 mt-0.5">Show table cell borders for debugging</div>
                </button>
              )}
            </div>
          </div>

          {/* Event log */}
          <div>
            <div className="text-white/30 text-[9px] uppercase tracking-wider mb-1.5">Event log</div>
            <div className="bg-black/40 rounded p-2 max-h-[200px] overflow-y-auto">
              {debugLog.length === 0 ? (
                <span className="text-white/25 italic">No events yet — interact with the agent to see logs</span>
              ) : (
                debugLog.map((line, i) => (
                  <div key={i} className="text-[10px] text-white/50 leading-snug">{line}</div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
