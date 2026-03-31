import { useState, useEffect, useMemo, useRef } from 'react'
import { useSSE } from './hooks/useSSE'
import { useGridLayout } from './hooks/useLayout'
import { fetchSessions, focusAgent, fetchConnections, fetchSpriteOverrides, fetchMessageHistory, fetchActivity, fetchProfiles, fetchProjectList, fetchRoleList, launchProfile, shutdownAgent, ActivityEntry, ProfileInfo, ProjectInfo, RoleInfo } from './api'
import { AgentState, AgentConnection, AgentMessage } from './types'
import { AgentCard } from './components/AgentCard'
import { SessionBrowser } from './components/SessionBrowser'
import { hashString } from './components/CreatureIcon'
import { POKEMON_SPRITES } from './components/sprites'
import { useMessageAnimations, DeliveryOverlay } from './components/MessageAnimations'
import { useSettings } from './hooks/useSettings'
import { SettingsPanel } from './components/SettingsPanel'
import { LaunchModal } from './components/LaunchModal'

const STATUS_PILLS: Record<string, { label: string; bg: string; pulse?: boolean }> = {
  idle:        { label: 'SLP',  bg: '#788890' },
  done:        { label: 'OK',   bg: '#58a868' },
  busy:        { label: 'ATK',  bg: '#e87848', pulse: true },
  needs_input: { label: 'WAIT', bg: '#d84848', pulse: true },
  error:       { label: 'PSN',  bg: '#a858a8', pulse: true },
  starting:    { label: 'NEW',  bg: '#5898c8', pulse: true },
}

function formatInactive(lastUpdated?: string): string {
  if (!lastUpdated) return ''
  const secs = Math.max(0, (Date.now() - new Date(lastUpdated).getTime()) / 1000)
  if (secs < 60) return `${Math.floor(secs)}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`
}

function CollapsedBubble({ agent, sprite, statusColor, onExpand, onFocus }: {
  agent: AgentState; sprite: string; statusColor: string; onExpand: () => void; onFocus: () => void
}) {
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // Update duration every 30s
  useEffect(() => {
    const iv = setInterval(() => setTick(n => n + 1), 30000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const st = STATUS_PILLS[agent.state] || STATUS_PILLS.idle
  const dur = formatInactive(agent.last_updated)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={`relative flex items-center gap-1.5 gba-card rounded-full pl-1 pr-2.5 py-1 border-2 ${statusColor} transition-colors group`}
        title={`${agent.display_name} — ${agent.state}`}
      >
        <div className="w-5 h-5 flex items-center justify-center overflow-visible">
          <img src={`/sprites/${sprite}.png`} alt="" style={{ imageRendering: 'pixelated', transform: 'scale(0.8)' }} />
        </div>
        <span className="text-[7px] font-pixel text-white/80 group-hover:text-white max-w-[80px] truncate pixel-shadow">{agent.display_name}</span>
        <span
          className={`text-[5px] font-pixel text-white px-1 py-px rounded-full leading-none ${st.pulse ? 'animate-pulse-soft' : ''}`}
          style={{ backgroundColor: st.bg, textShadow: '1px 1px 0 rgba(0,0,0,0.4)', boxShadow: 'inset 1px 1px 0 rgba(255,255,255,0.2), inset -1px -1px 0 rgba(0,0,0,0.2)' }}
        >{st.label}</span>
        {dur && <span className="text-[6px] font-mono text-white/30">{dur}</span>}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 gba-panel z-50 py-1 min-w-[130px]">
          <button onClick={() => { onExpand(); setOpen(false) }} className="w-full text-left px-3 py-1.5 text-[7px] font-pixel text-white/90 hover:bg-white/10 transition-colors pixel-shadow">Expand</button>
          <button onClick={() => { onFocus(); setOpen(false) }} className="w-full text-left px-3 py-1.5 text-[7px] font-pixel text-white/90 hover:bg-white/10 transition-colors pixel-shadow">Focus terminal</button>
          <button onClick={() => { shutdownAgent(agent.session_id); setOpen(false) }} className="w-full text-left px-3 py-1.5 text-[7px] font-pixel text-accent-red hover:bg-white/10 transition-colors pixel-shadow">Shutdown</button>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const { settings, setSettings, reset: resetSettings, DEFAULTS } = useSettings()
  const { agents: sseAgents, connections: sseConnections, newMessage, connected } = useSSE()
  const [agents, setAgents] = useState<AgentState[]>([])
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [showBrowser, setShowBrowser] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const [spriteOverrides, setSpriteOverrides] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [bottomTab, setBottomTab] = useState<'messages' | 'activity'>('messages')
  const [bottomOpen, setBottomOpen] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const collapsedInitialized = useRef(false)
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const [showLauncher, setShowLauncher] = useState(false)
  const dragSrcId = useRef<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  // Restore from localStorage AFTER first agents load (so we know which IDs are valid)
  useEffect(() => {
    if (collapsedInitialized.current || agents.length === 0) return
    collapsedInitialized.current = true
    try {
      const saved: string[] = JSON.parse(localStorage.getItem('pokegents-collapsed') || '[]')
      const validIds = new Set(agents.map(a => a.session_id))
      const restored = saved.filter(id => validIds.has(id))
      if (restored.length > 0) {
        setCollapsedIds(new Set(restored))
      }
    } catch { /* ignore */ }
  }, [agents])

  // Persist collapsed state (skip the initial empty set)
  useEffect(() => {
    if (!collapsedInitialized.current) return
    localStorage.setItem('pokegents-collapsed', JSON.stringify([...collapsedIds]))
  }, [collapsedIds])

  // Track manually expanded agents so auto-collapse doesn't immediately re-collapse them
  const manualExpandRef = useRef<Set<string>>(new Set())

  // Auto-collapse after 15 min of inactivity (idle/done only), auto-expand when busy/needs_input
  useEffect(() => {
    if (!collapsedInitialized.current || agents.length === 0 || settings.autoCollapseMinutes === 0) return
    const AUTO_COLLAPSE_MS = settings.autoCollapseMinutes * 60 * 1000

    const check = () => {
      const now = Date.now()
      const toCollapse: string[] = []
      const toExpand: string[] = []

      for (const a of agents) {
        const age = a.last_updated ? now - new Date(a.last_updated).getTime() : 0
        const inactive = a.state === 'idle' || a.state === 'done'
        const active = a.state === 'busy' || a.state === 'needs_input'

        if (inactive && age >= AUTO_COLLAPSE_MS && !manualExpandRef.current.has(a.session_id)) {
          toCollapse.push(a.session_id)
        }
        if (active) {
          toExpand.push(a.session_id)
          manualExpandRef.current.delete(a.session_id) // reset manual flag when agent becomes active
        }
      }

      if (toCollapse.length > 0 || toExpand.length > 0) {
        setCollapsedIds(prev => {
          const next = new Set(prev)
          for (const id of toCollapse) next.add(id)
          for (const id of toExpand) next.delete(id)
          if (next.size === prev.size && [...next].every(id => prev.has(id))) return prev
          return next
        })
      }
    }

    check()
    const iv = setInterval(check, 30000)
    return () => clearInterval(iv)
  }, [agents, settings.autoCollapseMinutes])

  const msgLogRef = useRef<HTMLDivElement>(null)
  const actLogRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  // useMessageAnimations moved below getSpriteForId (needs it as dependency)
  // Layout computed after visibleAgents (below)
  // showHeader computed after layout (below)

  useEffect(() => {
    fetchSessions().then(setAgents).catch(() => {})
    fetchConnections().then(setConnections).catch(() => {})
    fetchSpriteOverrides().then(setSpriteOverrides).catch(() => {})
    fetchMessageHistory().then(setMessages).catch(() => {})
    fetchActivity().then(setActivity).catch(() => {})
    fetchProfiles().then(p => setProfiles(p.sort((a, b) => a.title.localeCompare(b.title)))).catch(() => {})
    fetchProjectList().then(p => setProjects(p.sort((a, b) => a.title.localeCompare(b.title)))).catch(() => {})
    fetchRoleList().then(r => setRoles(r.sort((a, b) => a.title.localeCompare(b.title)))).catch(() => {})
    // Poll messages + activity every 5s, fallback session poll every 10s
    const interval = setInterval(() => {
      fetchMessageHistory().then(msgs => {
        setMessages(prev => msgs.length !== prev.length ? msgs : prev)
      }).catch(() => {})
      fetchActivity().then(acts => {
        setActivity(prev => acts.length !== prev.length ? acts : prev)
      }).catch(() => {})
    }, 5000)
    const fallbackPoll = setInterval(() => {
      fetchSessions().then(fresh => {
        setAgents(prev => {
          if (fresh.length !== prev.length) return fresh
          for (let i = 0; i < fresh.length; i++) {
            if (fresh[i].session_id !== prev[i].session_id ||
                fresh[i].state !== prev[i].state ||
                fresh[i].detail !== prev[i].detail ||
                fresh[i].user_prompt !== prev[i].user_prompt ||
                fresh[i].display_name !== prev[i].display_name) return fresh
          }
          return prev
        })
      }).catch(() => {})
    }, 10000)
    return () => { clearInterval(interval); clearInterval(fallbackPoll) }
  }, [])

  useEffect(() => {
    if (sseAgents.length > 0) setAgents(sseAgents)
  }, [sseAgents])

  useEffect(() => {
    if (sseConnections.length > 0) setConnections(sseConnections)
  }, [sseConnections])

  // Instantly append new messages from SSE (no poll delay)
  useEffect(() => {
    if (newMessage) {
      setMessages(prev => prev.some(m => m.id === newMessage.id) ? prev : [...prev, newMessage])
    }
  }, [newMessage])

  const baseVisible = useMemo(() => agents.filter(a => !collapsedIds.has(a.session_id)), [agents, collapsedIds])
  const collapsedAgents = useMemo(() => agents.filter(a => collapsedIds.has(a.session_id)), [agents, collapsedIds])
  const visibleAgents = baseVisible

  const { cols, mode } = useGridLayout(visibleAgents.length, {
    cardHeight: settings.cardHeight,
    cardMinWidth: settings.cardMinWidth,
  })
  const showHeader = mode === 'standard'
  const isCompact = mode === 'compact' || mode === 'compact-minimal'


  // Map any ID → ccd_session_id (for sprite hashing — matches pokegent.sh which hashes the ccd UUID)
  // Also map to session_id for agent lookups
  const resolveToSpriteId = useMemo(() => {
    const m: Record<string, string> = {}
    for (const a of agents) {
      // The sprite ID is the ccd_session_id (what pokegent.sh hashes), fallback to session_id
      const spriteId = a.ccd_session_id || a.session_id
      m[a.session_id] = spriteId
      if (a.ccd_session_id) m[a.ccd_session_id] = spriteId
    }
    return (id: string) => m[id] || id
  }, [agents])

  const resolveId = useMemo(() => {
    const m: Record<string, string> = {}
    for (const a of agents) {
      m[a.session_id] = a.session_id
      if (a.ccd_session_id && a.ccd_session_id !== a.session_id) m[a.ccd_session_id] = a.session_id
    }
    return (id: string) => m[id] || id
  }, [agents])

  const getSpriteForId = useMemo(() => {
    return (id: string) => {
      const spriteId = resolveToSpriteId(id)
      const sessionId = resolveId(id)
      // Check overrides under both IDs (override may be keyed by either)
      return spriteOverrides[spriteId] || spriteOverrides[sessionId] || spriteOverrides[id] || POKEMON_SPRITES[hashString(spriteId) % POKEMON_SPRITES.length]
    }
  }, [resolveToSpriteId, resolveId, spriteOverrides])

  const { deliveries, hiddenSprites, readingAgents, triggerTestDelivery } = useMessageAnimations(messages, cardRefs, spriteOverrides, getSpriteForId)

  // Build a map of session_id → connected agent info (for icons)
  const agentMap = useMemo(() => {
    const m: Record<string, { session_id: string; emoji: string; display_name: string }> = {}
    for (const a of agents) {
      m[a.session_id] = { session_id: a.session_id, emoji: a.emoji, display_name: a.display_name || a.profile_name }
      if (a.ccd_session_id && a.ccd_session_id !== a.session_id) {
        m[a.ccd_session_id] = m[a.session_id]
      }
    }
    return m
  }, [agents])

  const connectedAgentsMap = useMemo(() => {
    const map: Record<string, { session_id: string; emoji: string; display_name: string }[]> = {}
    for (const conn of connections) {
      const a = agentMap[conn.agent_a]
      const b = agentMap[conn.agent_b]
      if (a) {
        if (!map[conn.agent_a]) map[conn.agent_a] = []
        if (b && !map[conn.agent_a].some(x => x.session_id === b.session_id)) map[conn.agent_a].push(b)
      }
      if (b) {
        if (!map[conn.agent_b]) map[conn.agent_b] = []
        if (a && !map[conn.agent_b].some(x => x.session_id === a.session_id)) map[conn.agent_b].push(a)
      }
    }
    return map
  }, [connections, agentMap])

  // Auto-scroll message/activity logs
  useEffect(() => {
    if (msgLogRef.current) msgLogRef.current.scrollTop = msgLogRef.current.scrollHeight
  }, [messages.length])
  useEffect(() => {
    if (actLogRef.current) actLogRef.current.scrollTop = actLogRef.current.scrollHeight
  }, [activity.length])

  // Keyboard shortcut: / to search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !showBrowser && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault()
        setShowBrowser(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showBrowser])



  const dragAllowed = useRef(true)

  // iOS-style grid layout: each card has {col, row, w, h} on the grid
  const ROW_H = mode === 'standard' ? settings.cardHeight : mode === 'compact' ? 128 : 92
  const GRID_GAP = 8
  type CardLayout = { col: number; row: number; w: number; h: number }
  const [cardLayouts, setCardLayouts] = useState<Record<string, CardLayout>>(() => {
    try {
      return JSON.parse(localStorage.getItem('pokegents-card-layouts') || '{}')
    } catch { return {} }
  })
  const [dropPreview, setDropPreview] = useState<{ col: number; row: number } | null>(null)
  const resizeRef = useRef<{ id: string; startX: number; startY: number; startW: number; startH: number } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  // Persist layouts
  const persistLayouts = (layouts: Record<string, CardLayout>) => {
    localStorage.setItem('pokegents-card-layouts', JSON.stringify(layouts))
  }

  // Compute grid cell from mouse position
  const getGridCell = (e: React.DragEvent | MouseEvent) => {
    if (!gridRef.current) return { col: 1, row: 1 }
    const rect = gridRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top + gridRef.current.scrollTop
    const colWidth = (rect.width - (cols - 1) * GRID_GAP) / cols
    const col = Math.floor(x / (colWidth + GRID_GAP)) + 1
    const row = Math.floor(y / (ROW_H + GRID_GAP)) + 1
    return { col: Math.max(1, Math.min(cols, col)), row: Math.max(1, row) }
  }

  // Auto-assign positions for cards without explicit layouts
  const getLayout = (agentId: string, index: number): CardLayout => {
    if (!isCompact && activeLayouts[agentId]) return activeLayouts[agentId]
    // Default: sequential placement
    const col = (index % cols) + 1
    const row = Math.floor(index / cols) + 1
    return { col, row, w: 1, h: 1 }
  }

  // Check if two card rects overlap
  const overlaps = (a: CardLayout, b: CardLayout) =>
    a.col < b.col + b.w && a.col + a.w > b.col && a.row < b.row + b.h && a.row + a.h > b.row

  // iOS-style collision resolution: push overlapping cards down
  const resolveCollisions = (layouts: Record<string, CardLayout>, movedId: string): Record<string, CardLayout> => {
    const result = { ...layouts }
    const moved = result[movedId]
    if (!moved) return result
    for (const [id, layout] of Object.entries(result)) {
      if (id !== movedId && overlaps(moved, layout)) {
        result[id] = { ...layout, row: moved.row + moved.h }
      }
    }
    // Recursively resolve cascading collisions
    for (let iter = 0; iter < 20; iter++) {
      let ok = true
      const ids = Object.keys(result)
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (overlaps(result[ids[i]], result[ids[j]])) {
            const [upper, lower] = result[ids[i]].row <= result[ids[j]].row ? [ids[i], ids[j]] : [ids[j], ids[i]]
            result[lower] = { ...result[lower], row: result[upper].row + result[upper].h }
            ok = false
          }
        }
      }
      if (ok) break
    }
    return result
  }

  // Ensure all visible agents have layouts
  const ensureAllLayouts = () => {
    const all = { ...cardLayouts }
    visibleAgents.forEach((a, i) => {
      if (!all[a.session_id]) all[a.session_id] = getLayout(a.session_id, i)
    })
    return all
  }

  // Live preview layouts — resolved collision state during drag
  const [previewLayouts, setPreviewLayouts] = useState<Record<string, CardLayout> | null>(null)

  // The active layout: preview during drag, committed otherwise
  const activeLayouts = previewLayouts || cardLayouts

  // Compute max row from active layouts
  const maxRow = useMemo(() => {
    let max = 1
    visibleAgents.forEach((a, i) => {
      const layout = activeLayouts[a.session_id] || getLayout(a.session_id, i)
      max = Math.max(max, layout.row + layout.h - 1)
    })
    return max + 2 // extra rows for drop targets
  }, [visibleAgents, activeLayouts, cols, isCompact])

  // Live drag — resolve collisions on every hover cell change
  const lastDragCell = useRef<string>('')
  const handleGridDragOver = (e: React.DragEvent) => {
    if (!dragSrcId.current || isCompact) return
    e.preventDefault()
    const cell = getGridCell(e)
    const cellKey = `${cell.col},${cell.row}`
    if (cellKey === lastDragCell.current) return // debounce same cell
    lastDragCell.current = cellKey
    setDropPreview(cell)

    const srcId = dragSrcId.current
    const existing = cardLayouts[srcId] || getLayout(srcId, 0)
    const clampedCol = Math.max(1, Math.min(cell.col, cols - existing.w + 1))
    const clampedRow = Math.max(1, cell.row)

    const all = ensureAllLayouts()
    all[srcId] = { ...existing, col: clampedCol, row: clampedRow }
    setPreviewLayouts(resolveCollisions(all, srcId))
  }

  const handleGridDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (!previewLayouts) return
    // Commit the preview
    setCardLayouts(previewLayouts)
    persistLayouts(previewLayouts)
    setPreviewLayouts(null)
    dragSrcId.current = null
    setIsDragging(false)
    setDropPreview(null)
    lastDragCell.current = ''
  }

  const handleDragEnd = () => {
    // Cancel — revert to committed layouts
    setPreviewLayouts(null)
    dragSrcId.current = null
    setIsDragging(false)
    setDropPreview(null)
    lastDragCell.current = ''
  }

  // Resize handler (size only, position stays)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current || !gridRef.current) return
      const r = resizeRef.current
      const gridWidth = gridRef.current.offsetWidth
      const colWidth = (gridWidth - (cols - 1) * GRID_GAP) / cols
      const deltaX = e.clientX - r.startX
      const totalW = r.startW * colWidth + (r.startW - 1) * GRID_GAP + deltaX
      const newW = Math.max(1, Math.min(cols, Math.round((totalW + GRID_GAP) / (colWidth + GRID_GAP))))
      const deltaY = e.clientY - r.startY
      const totalH = r.startH * ROW_H + (r.startH - 1) * GRID_GAP + deltaY
      const newH = Math.max(1, Math.min(4, Math.round((totalH + GRID_GAP) / (ROW_H + GRID_GAP))))
      const prev = cardLayouts[r.id]
      const prevW = prev?.w || 1
      const prevH = prev?.h || 1
      if (newW !== prevW || newH !== prevH) {
        setCardLayouts(p => ({ ...p, [r.id]: { ...(p[r.id] || { col: 1, row: 1, w: 1, h: 1 }), w: newW, h: newH } }))
      }
    }
    const onUp = () => {
      const id = resizeRef.current?.id
      resizeRef.current = null
      if (id) {
        setCardLayouts(current => {
          const resolved = resolveCollisions(current, id)
          persistLayouts(resolved)
          return resolved
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [cols, cardLayouts, ROW_H])

  const renderCard = (agent: AgentState, cardMode: typeof mode, index: number) => {
    const layout = getLayout(agent.session_id, index)
    const h = layout.h * ROW_H + (layout.h - 1) * GRID_GAP
    return (
      <div
        key={agent.session_id}
        draggable={dragAllowed.current}
        onMouseDown={(e) => {
          const el = e.target as HTMLElement
          dragAllowed.current = !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || !!el.closest('[data-no-drag]'))
        }}
        onDragStart={(e) => {
          if (!dragAllowed.current) { e.preventDefault(); return }
          dragSrcId.current = agent.session_id
          setIsDragging(true)
          e.dataTransfer.effectAllowed = 'move'
          // Assign layout if card doesn't have one yet
          if (!cardLayouts[agent.session_id]) {
            setCardLayouts(p => ({ ...p, [agent.session_id]: layout }))
          }
        }}
        onDragEnd={handleDragEnd}
        className="relative"
        style={{
          height: h,
          gridColumn: `${layout.col} / span ${layout.w}`,
          gridRow: `${layout.row} / span ${layout.h}`,
          transition: resizeRef.current ? 'none' : 'transform 200ms ease',
        }}
      >
        <AgentCard
          agent={agent}
          onClick={() => focusAgent(agent.session_id)}
          mode={cardMode}
          connectedAgents={connectedAgentsMap[agent.session_id]}
          spriteOverride={spriteOverrides[resolveToSpriteId(agent.session_id)] || spriteOverrides[agent.session_id]}
          spriteSessionId={resolveToSpriteId(agent.session_id)}
          isReading={readingAgents.has(agent.session_id)}
          hideSprite={hiddenSprites.has(agent.session_id)}
          projects={projects}
          roles={roles}
          onCollapse={() => setCollapsedIds(prev => new Set([...prev, agent.session_id]))}
          cardRef={(el) => {
            if (el) {
              cardRefs.current.set(agent.session_id, el)
              if (agent.ccd_session_id && agent.ccd_session_id !== agent.session_id) cardRefs.current.set(agent.ccd_session_id, el)
            } else {
              cardRefs.current.delete(agent.session_id)
              if (agent.ccd_session_id) cardRefs.current.delete(agent.ccd_session_id)
            }
          }}
        />
        {/* Resize handle — only in standard mode */}
        {!isCompact && (
          <div
            data-no-drag
            className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-10 opacity-0 hover:opacity-100 transition-opacity"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // Ensure layout exists before resizing
              if (!cardLayouts[agent.session_id]) {
                setCardLayouts(p => ({ ...p, [agent.session_id]: layout }))
              }
              resizeRef.current = {
                id: agent.session_id,
                startX: e.clientX,
                startY: e.clientY,
                startW: layout.w,
                startH: layout.h,
              }
            }}
          >
            <svg viewBox="0 0 16 16" className="w-full h-full text-white/40">
              <line x1="4" y1="14" x2="14" y2="4" stroke="currentColor" strokeWidth="1.5" />
              <line x1="8" y1="14" x2="14" y2="8" stroke="currentColor" strokeWidth="1.5" />
              <line x1="12" y1="14" x2="14" y2="12" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col p-3 overflow-hidden relative z-10">
      {/* Header — hidden in compact mode */}
      {showHeader && (
        <div className="flex items-center justify-between shrink-0 mb-2">
          <div className="flex items-center gap-3">
            <h1 className="text-[10px] font-pixel text-white pixel-shadow">POKéGENTS</h1>
            <span className="text-[8px] font-pixel text-white/50">
              {agents.length} active
              <span className={`ml-1.5 ${connected ? 'text-accent-green' : 'text-accent-red'}`}>●</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowLauncher(true)}
              className="gba-button text-[7px] font-pixel px-3 py-1.5 transition-colors"
            >
              NEW AGENT
            </button>
            <button
              onClick={() => setShowBrowser(true)}
              className="gba-button text-[7px] font-pixel px-3 py-1.5 transition-colors"
            >
              PC BOX
            </button>
            <div className="relative" ref={settingsRef}>
              <button
                onClick={() => setShowSettings(v => !v)}
                className="gba-button text-[7px] font-pixel px-2.5 py-1.5 transition-colors"
                title="Settings"
              >
                SETTINGS
              </button>
              {showSettings && (
                <SettingsPanel
                  settings={settings}
                  defaults={DEFAULTS}
                  onChange={setSettings}
                  onReset={resetSettings}
                  onClose={() => setShowSettings(false)}
                  onTestMessaging={triggerTestDelivery}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Collapsed agent bubbles */}
      {collapsedAgents.length > 0 && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {collapsedAgents.map(agent => {
            const sprite = getSpriteForId(agent.session_id)
            const statusColor = agent.state === 'busy' ? 'border-accent-yellow' : agent.state === 'done' ? 'border-accent-green' : agent.state === 'error' ? 'border-accent-orange' : agent.state === 'needs_input' ? 'border-accent-red' : 'border-gba-card-dark'
            return (
              <CollapsedBubble
                key={agent.session_id}
                agent={agent}
                sprite={sprite}
                statusColor={statusColor}
                onExpand={() => { manualExpandRef.current.add(agent.session_id); setCollapsedIds(prev => { const next = new Set(prev); next.delete(agent.session_id); return next }) }}
                onFocus={() => focusAgent(agent.session_id)}
              />
            )
          })}
        </div>
      )}

      {/* Grid */}
      {agents.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="gba-dialog text-center px-8 py-6">
            <p className="text-[9px] font-pixel text-gba-dialog-border">No POKéMON in party</p>
            <p className="text-[7px] font-pixel text-gba-dialog-border/60 mt-3">
              Start with <span className="text-gba-card">pokegents &lt;profile&gt;</span>
            </p>
          </div>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="flex-1 grid gap-2 min-h-0 content-start items-start overflow-auto"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridAutoRows: ROW_H,
          }}
          onDragOver={handleGridDragOver}
          onDrop={handleGridDrop}
        >
          {/* Background grid cells + column lines — visible during drag */}
          {isDragging && !isCompact && (
            <>
              {Array.from({ length: maxRow * cols }, (_, i) => {
                const c = (i % cols) + 1
                const r = Math.floor(i / cols) + 1
                return (
                  <div
                    key={`grid-${c}-${r}`}
                    className="rounded-lg border border-dashed pointer-events-none"
                    style={{
                      gridColumn: `${c} / span 1`,
                      gridRow: `${r} / span 1`,
                      borderColor: 'rgba(255,255,255,0.06)',
                    }}
                  />
                )
              })}
              {/* Vertical column separator lines */}
              {Array.from({ length: cols - 1 }, (_, i) => (
                <div
                  key={`vsep-${i}`}
                  className="pointer-events-none"
                  style={{
                    gridColumn: `${i + 2} / span 1`,
                    gridRow: `1 / span ${maxRow}`,
                    borderLeft: '1px dashed rgba(255,255,255,0.12)',
                    marginLeft: -5,
                  }}
                />
              ))}
            </>
          )}
          {visibleAgents.map((agent, i) => renderCard(agent, mode, i))}
          {/* Drop preview ghost — matches dragged card's size */}
          {dropPreview && isDragging && dragSrcId.current && !isCompact && (() => {
            const srcLayout = activeLayouts[dragSrcId.current] || { w: 1, h: 1 }
            const clampedCol = Math.max(1, Math.min(dropPreview.col, cols - srcLayout.w + 1))
            return (
              <div
                className="rounded-lg border-2 border-dashed border-white/25 pointer-events-none"
                style={{
                  gridColumn: `${clampedCol} / span ${srcLayout.w}`,
                  gridRow: `${dropPreview.row} / span ${srcLayout.h}`,
                  background: 'rgba(255,255,255,0.06)',
                }}
              />
            )
          })()}
        </div>
      )}

      {/* Bottom bar — Messages + Activity tabs */}
      {(messages.length > 0 || activity.length > 0) && (
        <div className="shrink-0 mt-2 border-t-2 border-gba-teal-dark pt-2">
          <div className="flex items-center gap-3 mb-1 px-0.5">
            <button
              onClick={() => setBottomOpen(o => !o)}
              className="text-[9px] text-white/40 hover:text-white/70 mr-1"
            >
              {bottomOpen ? '▼' : '▶'}
            </button>
            <button
              onClick={() => { setBottomTab('messages'); setBottomOpen(true) }}
              className={`text-[8px] font-pixel uppercase pixel-shadow ${bottomTab === 'messages' ? 'text-white' : 'text-white/40 hover:text-white/70'}`}
            >
              MAIL{messages.length > 0 ? ` (${messages.length})` : ''}
            </button>
            <button
              onClick={() => { setBottomTab('activity'); setBottomOpen(true) }}
              className={`text-[8px] font-pixel uppercase pixel-shadow ${bottomTab === 'activity' ? 'text-white' : 'text-white/40 hover:text-white/70'}`}
            >
              LOG{activity.length > 0 ? ` (${activity.length})` : ''}
            </button>
          </div>

          {bottomOpen && (bottomTab === 'messages' ? (
            <div ref={msgLogRef} className="max-h-28 overflow-y-auto overflow-x-hidden space-y-1 gba-panel p-2">
              {messages.length === 0 ? (
                <div className="text-[10px] font-mono text-white/30">No mail yet</div>
              ) : messages.map((msg) => {
                const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
                const fromSprite = getSpriteForId(msg.from)
                const toSprite = getSpriteForId(msg.to)
                return (
                  <div key={msg.id + (msg.delivered ? '-d' : '')} className="flex items-start gap-1.5 text-[10px] font-mono">
                    <span className="text-white/30 shrink-0 mt-0.5">{time}</span>
                    <span className="inline-flex items-center gap-1 bg-gba-card/40 rounded-full px-1.5 py-0.5 shrink-0">
                      <img src={`/sprites/${fromSprite}.png`} alt="" className="w-3 h-3" style={{ imageRendering: 'pixelated' }} />
                      <span className="text-white/80 text-[9px]">{msg.from_name}</span>
                    </span>
                    <span className="text-accent-yellow shrink-0 mt-0.5">→</span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 shrink-0 ${
                      msg.delivered
                        ? 'bg-gba-card/40'
                        : 'bg-transparent border border-dashed border-white/30 animate-pulse-soft'
                    }`}>
                      <img src={`/sprites/${toSprite}.png`} alt="" className="w-3 h-3" style={{ imageRendering: 'pixelated' }} />
                      <span className={`text-[9px] ${msg.delivered ? 'text-white/80' : 'text-white/40'}`}>{msg.to_name}</span>
                    </span>
                    <span className="text-white/50 truncate mt-0.5">{msg.content.slice(0, 100)}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div ref={actLogRef} className="max-h-28 overflow-y-auto overflow-x-hidden space-y-1 gba-panel p-2">
              {activity.length === 0 ? (
                <div className="text-[10px] font-mono text-white/30">No activity yet</div>
              ) : activity.map((entry, i) => {
                const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
                const sprite = getSpriteForId(entry.session_id)
                return (
                  <div
                    key={i}
                    className="flex items-start gap-1.5 text-[10px] font-mono cursor-pointer hover:bg-white/10 rounded px-0.5"
                    onClick={() => focusAgent(entry.session_id)}
                  >
                    <span className="text-white/30 shrink-0 mt-0.5">{time}</span>
                    <span className="inline-flex items-center gap-1 bg-gba-card/40 rounded-full px-1.5 py-0.5 shrink-0">
                      <img src={`/sprites/${sprite}.png`} alt="" className="w-3 h-3" style={{ imageRendering: 'pixelated' }} />
                      <span className="text-white/80 text-[9px]">{entry.agent_name}</span>
                    </span>
                    {entry.files && <span className="text-accent-yellow/70 truncate mt-0.5">{entry.files}</span>}
                    {entry.files && entry.summary && <span className="text-white/20 shrink-0 mt-0.5">—</span>}
                    <span className="text-white/50 truncate mt-0.5">{entry.summary}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      <DeliveryOverlay deliveries={deliveries} />
      {showBrowser && <SessionBrowser onClose={() => setShowBrowser(false)} activeSessionIds={new Set(agents.map(a => a.session_id))} />}
      {showLauncher && <LaunchModal projects={projects} roles={roles} agents={agents} onClose={() => setShowLauncher(false)} />}
    </div>
  )
}

