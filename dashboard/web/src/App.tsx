import { useState, useEffect, useMemo, useRef } from 'react'
import { useSSE } from './hooks/useSSE'
import { useGridLayout } from './hooks/useLayout'
import { fetchSessions, focusAgent, fetchConnections, fetchSpriteOverrides, fetchMessageHistory, fetchActivity, fetchProfiles, launchProfile, saveAgentOrder, ActivityEntry, ProfileInfo } from './api'
import { AgentState, AgentConnection, AgentMessage } from './types'
import { AgentCard } from './components/AgentCard'
import { SessionBrowser } from './components/SessionBrowser'
import { hashString } from './components/CreatureIcon'
import { POKEMON_SPRITES } from './components/sprites'
import { useMessageAnimations, DeliveryOverlay } from './components/MessageAnimations'

export default function App() {
  const { agents: sseAgents, connections: sseConnections, newMessage, connected } = useSSE()
  const [agents, setAgents] = useState<AgentState[]>([])
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [showBrowser, setShowBrowser] = useState(false)
  const [spriteOverrides, setSpriteOverrides] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [bottomTab, setBottomTab] = useState<'messages' | 'activity'>('messages')
  const [bottomOpen, setBottomOpen] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const collapsedInitialized = useRef(false)
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [showLauncher, setShowLauncher] = useState(false)
  const launcherRef = useRef<HTMLDivElement>(null)
  const dragSrcId = useRef<string | null>(null)

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
  const msgLogRef = useRef<HTMLDivElement>(null)
  const actLogRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const { deliveries, hiddenSprites, readingAgents, triggerTestDelivery } = useMessageAnimations(messages, cardRefs, spriteOverrides)
  // Layout computed after visibleAgents (below)
  // showHeader computed after layout (below)

  useEffect(() => {
    fetchSessions().then(setAgents).catch(() => {})
    fetchConnections().then(setConnections).catch(() => {})
    fetchSpriteOverrides().then(setSpriteOverrides).catch(() => {})
    fetchMessageHistory().then(setMessages).catch(() => {})
    fetchActivity().then(setActivity).catch(() => {})
    fetchProfiles().then(p => setProfiles(p.sort((a, b) => a.title.localeCompare(b.title)))).catch(() => {})
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

  // Server returns agents in user-defined order (or creation time for unordered).
  // During drag, we override with a local order for live preview.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)

  const baseVisible = useMemo(() => agents.filter(a => !collapsedIds.has(a.session_id)), [agents, collapsedIds])
  const collapsedAgents = useMemo(() => agents.filter(a => collapsedIds.has(a.session_id)), [agents, collapsedIds])

  const visibleAgents = useMemo(() => {
    if (!dragOrder) return baseVisible
    // Reorder baseVisible according to dragOrder
    const map = new Map(baseVisible.map(a => [a.session_id, a]))
    const ordered: AgentState[] = []
    for (const id of dragOrder) {
      const a = map.get(id)
      if (a) ordered.push(a)
    }
    // Append any agents not in dragOrder (newly spawned)
    for (const a of baseVisible) {
      if (!dragOrder.includes(a.session_id)) ordered.push(a)
    }
    return ordered
  }, [baseVisible, dragOrder])

  const { profileCount, agentsPerProfile } = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const a of visibleAgents) {
      counts[a.profile_name || 'other'] = (counts[a.profile_name || 'other'] || 0) + 1
    }
    return { profileCount: Object.keys(counts).length, agentsPerProfile: Object.values(counts) }
  }, [visibleAgents])
  const { cols, mode } = useGridLayout(visibleAgents.length, profileCount, agentsPerProfile)
  const showHeader = mode === 'max' || mode === 'standard' || mode === 'standard-short'

  // Group by profile for non-compact mode
  const grouped = useMemo(() => {
    const groups: Record<string, AgentState[]> = {}
    for (const a of visibleAgents) {
      const key = a.profile_name || 'other'
      if (!groups[key]) groups[key] = []
      groups[key].push(a)
    }
    return Object.entries(groups)
  }, [visibleAgents])

  // Map any ID (session_id or ccd_session_id) → session_id for sprite/agent lookups
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
      const sid = resolveId(id)
      return spriteOverrides[sid] || POKEMON_SPRITES[hashString(sid) % POKEMON_SPRITES.length]
    }
  }, [resolveId, spriteOverrides])

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
      if (e.key === '/' && !showBrowser && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        setShowBrowser(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showBrowser])

  // Close launcher dropdown on click outside
  useEffect(() => {
    if (!showLauncher) return
    const handler = (e: MouseEvent) => {
      if (launcherRef.current && !launcherRef.current.contains(e.target as Node)) {
        setShowLauncher(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showLauncher])

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    const srcId = dragSrcId.current
    if (!srcId || srcId === targetId) return
    setDragOrder(prev => {
      const ids = prev || visibleAgents.map(a => a.session_id)
      const srcIdx = ids.indexOf(srcId)
      const tgtIdx = ids.indexOf(targetId)
      if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return prev
      const next = [...ids]
      next.splice(srcIdx, 1)
      next.splice(tgtIdx, 0, srcId)
      return next
    })
  }

  const handleDrop = () => {
    if (dragOrder) {
      const allIds = [...dragOrder, ...collapsedAgents.map(a => a.session_id)]
      saveAgentOrder(allIds)
    }
    dragSrcId.current = null
    setDragOrder(null)
  }

  const handleDragEnd = () => {
    dragSrcId.current = null
    setDragOrder(null)
  }

  const dragAllowed = useRef(true)

  const renderCard = (agent: AgentState, cardMode: typeof mode) => (
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
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => handleDragOver(e, agent.session_id)}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
      style={{ transition: 'transform 200ms ease' }}
    >
      <AgentCard
        agent={agent}
        onClick={() => focusAgent(agent.session_id)}
        mode={cardMode}
        connectedAgents={connectedAgentsMap[agent.session_id]}
        spriteOverride={spriteOverrides[agent.session_id]}
        isReading={readingAgents.has(agent.session_id)}
        hideSprite={hiddenSprites.has(agent.session_id)}

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
    </div>
  )

  return (
    <div className="h-screen flex flex-col p-3 overflow-hidden">
      {/* Header — hidden in compact mode */}
      {showHeader && (
        <div className="flex items-center justify-between shrink-0 mb-2">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-zinc-100">Agents</h1>
            <span className="text-[10px] text-zinc-600">
              {agents.length} active
              <span className={`ml-1.5 ${connected ? 'text-accent-green' : 'text-accent-red'}`}>●</span>
            </span>
            <div className="relative" ref={launcherRef}>
              <button
                onClick={() => setShowLauncher(v => !v)}
                className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-1 rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors"
              >
                + New
              </button>
              {showLauncher && (
                <div className="absolute top-full left-0 mt-1 bg-surface-1 border border-zinc-800 rounded-lg shadow-xl z-50 py-1 min-w-[160px]">
                  {profiles.map(p => (
                    <button
                      key={p.name}
                      onClick={() => { launchProfile(p.name); setShowLauncher(false) }}
                      className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-surface-2 hover:text-zinc-100 transition-colors flex items-center gap-2"
                    >
                      <span>{p.emoji}</span>
                      <span>{p.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={triggerTestDelivery}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 px-2 py-1 rounded-lg border border-zinc-800/50 hover:border-zinc-700 transition-colors"
            >
              ✉ Test
            </button>
            <button
              onClick={() => setShowBrowser(true)}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-1 rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors"
            >
              Previous sessions <kbd className="ml-1 text-zinc-600">/</kbd>
            </button>
          </div>
        </div>
      )}

      {/* Collapsed agent bubbles */}
      {collapsedAgents.length > 0 && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {collapsedAgents.map(agent => {
            const sprite = spriteOverrides[agent.session_id] || POKEMON_SPRITES[hashString(agent.session_id) % POKEMON_SPRITES.length]
            const statusColor = agent.state === 'busy' ? 'border-amber-500/50' : agent.state === 'done' ? 'border-emerald-500/50' : agent.state === 'error' ? 'border-orange-500/50' : agent.state === 'needs_input' ? 'border-red-500/50' : 'border-zinc-700'
            return (
              <button
                key={agent.session_id}
                onClick={() => setCollapsedIds(prev => { const next = new Set(prev); next.delete(agent.session_id); return next })}
                className={`relative flex items-center gap-1.5 bg-zinc-900 hover:bg-zinc-800 rounded-full pl-1 pr-2.5 py-1 border ${statusColor} transition-colors group`}
                title={`${agent.display_name} — ${agent.state}\nClick to expand`}
              >
                <div className="w-5 h-5 flex items-center justify-center overflow-visible">
                  <img src={`/sprites/${sprite}.png`} alt="" style={{ imageRendering: 'pixelated', transform: 'scale(0.8)' }} />
                </div>
                <span className="text-[9px] text-zinc-400 group-hover:text-zinc-200 max-w-[80px] truncate">{agent.display_name}</span>
                {agent.state === 'busy' && <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse-soft" />}
              </button>
            )
          })}
        </div>
      )}

      {/* Grid */}
      {agents.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-zinc-600">No agents running</p>
            <p className="text-xs text-zinc-700 mt-1">
              Start a session with <code className="text-accent-blue">pokegents &lt;profile&gt;</code>
            </p>
          </div>
        </div>
      ) : mode === 'max' ? (
        /* Max: grouped by profile in separate rows */
        <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3">
          {grouped.map(([profileName, profileAgents]) => (
            <div key={profileName}>
              <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-1.5 px-0.5">{profileName}</div>
              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                }}
              >
                {profileAgents.map((agent) => renderCard(agent, mode))}
              </div>
            </div>
          ))}
        </div>
      ) : mode === 'standard' || mode === 'standard-short' ? (
        /* Standard / standard-short: flat grid with header */
        <div
          className="flex-1 grid gap-2 min-h-0 content-start overflow-auto"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          }}
        >
          {visibleAgents.map((agent) => renderCard(agent, mode))}
        </div>
      ) : (
        /* Compact: flat grid, minimal */
        <div
          className="flex-1 grid gap-2 min-h-0 content-start overflow-auto"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          }}
        >
          {visibleAgents.map((agent) => renderCard(agent, mode))}
        </div>
      )}

      {/* Bottom bar — Messages + Activity tabs */}
      {(messages.length > 0 || activity.length > 0) && (
        <div className="shrink-0 mt-2 border-t border-zinc-800 pt-2">
          <div className="flex items-center gap-3 mb-1 px-0.5">
            <button
              onClick={() => setBottomOpen(o => !o)}
              className="text-[9px] text-zinc-600 hover:text-zinc-400 mr-1"
            >
              {bottomOpen ? '▼' : '▶'}
            </button>
            <button
              onClick={() => { setBottomTab('messages'); setBottomOpen(true) }}
              className={`text-[9px] uppercase tracking-wider ${bottomTab === 'messages' ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'}`}
            >
              Messages{messages.length > 0 ? ` (${messages.length})` : ''}
            </button>
            <button
              onClick={() => { setBottomTab('activity'); setBottomOpen(true) }}
              className={`text-[9px] uppercase tracking-wider ${bottomTab === 'activity' ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'}`}
            >
              Activity{activity.length > 0 ? ` (${activity.length})` : ''}
            </button>
          </div>

          {bottomOpen && (bottomTab === 'messages' ? (
            <div ref={msgLogRef} className="max-h-28 overflow-y-auto overflow-x-hidden space-y-1">
              {messages.length === 0 ? (
                <div className="text-[10px] text-zinc-700 font-mono">No messages yet</div>
              ) : messages.map((msg) => {
                const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
                const fromSprite = getSpriteForId(msg.from)
                const toSprite = getSpriteForId(msg.to)
                return (
                  <div key={msg.id + (msg.delivered ? '-d' : '')} className="flex items-start gap-1.5 text-[10px] font-mono">
                    <span className="text-zinc-700 shrink-0 mt-0.5">{time}</span>
                    <span className="inline-flex items-center gap-1 bg-zinc-800 rounded-full px-1.5 py-0.5 shrink-0">
                      <img src={`/sprites/${fromSprite}.png`} alt="" className="w-3 h-3" style={{ imageRendering: 'pixelated' }} />
                      <span className="text-zinc-300 text-[9px]">{msg.from_name}</span>
                    </span>
                    <span className="text-white shrink-0 mt-0.5">→</span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 shrink-0 ${
                      msg.delivered
                        ? 'bg-zinc-800'
                        : 'bg-transparent border border-dashed border-zinc-600 animate-pulse-soft'
                    }`}>
                      <img src={`/sprites/${toSprite}.png`} alt="" className="w-3 h-3" style={{ imageRendering: 'pixelated' }} />
                      <span className={`text-[9px] ${msg.delivered ? 'text-zinc-300' : 'text-zinc-500'}`}>{msg.to_name}</span>
                    </span>
                    <span className="text-zinc-500 truncate mt-0.5">{msg.content.slice(0, 100)}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div ref={actLogRef} className="max-h-28 overflow-y-auto overflow-x-hidden space-y-1">
              {activity.length === 0 ? (
                <div className="text-[10px] text-zinc-700 font-mono">No activity yet</div>
              ) : activity.map((entry, i) => {
                const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
                const sprite = getSpriteForId(entry.session_id)
                return (
                  <div
                    key={i}
                    className="flex items-start gap-1.5 text-[10px] font-mono cursor-pointer hover:bg-zinc-900/50 rounded px-0.5"
                    onClick={() => focusAgent(entry.session_id)}
                  >
                    <span className="text-zinc-700 shrink-0 mt-0.5">{time}</span>
                    <span className="inline-flex items-center gap-1 bg-zinc-800 rounded-full px-1.5 py-0.5 shrink-0">
                      <img src={`/sprites/${sprite}.png`} alt="" className="w-3 h-3" style={{ imageRendering: 'pixelated' }} />
                      <span className="text-zinc-300 text-[9px]">{entry.agent_name}</span>
                    </span>
                    {entry.files && <span className="text-amber-400/70 truncate mt-0.5">{entry.files}</span>}
                    {entry.files && entry.summary && <span className="text-zinc-700 shrink-0 mt-0.5">—</span>}
                    <span className="text-zinc-500 truncate mt-0.5">{entry.summary}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      <DeliveryOverlay deliveries={deliveries} />
      {showBrowser && <SessionBrowser onClose={() => setShowBrowser(false)} activeSessionIds={new Set(agents.map(a => a.session_id))} />}
    </div>
  )
}

