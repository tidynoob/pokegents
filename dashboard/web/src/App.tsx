import { useState, useEffect, useMemo, useRef } from 'react'
import { useSSE } from './hooks/useSSE'
import { useGridLayout } from './hooks/useLayout'
import { fetchSessions, focusAgent, fetchConnections, fetchSpriteOverrides, fetchMessageHistory, fetchActivity, ActivityEntry } from './api'
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
  const [mutedCtx, setMutedCtx] = useState(true)
  const msgLogRef = useRef<HTMLDivElement>(null)
  const actLogRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const { deliveries, hiddenSprites, readingAgents, triggerTestDelivery } = useMessageAnimations(messages, cardRefs, spriteOverrides)
  const { profileCount, agentsPerProfile } = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const a of agents) {
      counts[a.profile_name || 'other'] = (counts[a.profile_name || 'other'] || 0) + 1
    }
    return { profileCount: Object.keys(counts).length, agentsPerProfile: Object.values(counts) }
  }, [agents])
  const { cols, mode } = useGridLayout(agents.length, profileCount, agentsPerProfile)
  const showHeader = mode === 'max' || mode === 'standard' || mode === 'standard-short'

  useEffect(() => {
    fetchSessions().then(setAgents).catch(() => {})
    fetchConnections().then(setConnections).catch(() => {})
    fetchSpriteOverrides().then(setSpriteOverrides).catch(() => {})
    fetchMessageHistory().then(setMessages).catch(() => {})
    fetchActivity().then(setActivity).catch(() => {})
    // Poll messages + activity every 5s
    const interval = setInterval(() => {
      fetchMessageHistory().then(msgs => {
        setMessages(prev => msgs.length !== prev.length ? msgs : prev)
      }).catch(() => {})
      fetchActivity().then(acts => {
        setActivity(prev => acts.length !== prev.length ? acts : prev)
      }).catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
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

  // Sort agents by profile, then creation time (oldest first for stable ordering)
  const sorted = useMemo(() =>
    [...agents].sort((a, b) => {
      if (a.profile_name !== b.profile_name) return a.profile_name.localeCompare(b.profile_name)
      return (a.created_at || '').localeCompare(b.created_at || '')
    }),
    [agents]
  )

  // Group by profile for non-compact mode
  const grouped = useMemo(() => {
    const groups: Record<string, AgentState[]> = {}
    for (const a of sorted) {
      const key = a.profile_name || 'other'
      if (!groups[key]) groups[key] = []
      groups[key].push(a)
    }
    return Object.entries(groups)
  }, [sorted])

  // Build a map of session_id → connected agent info (for icons)
  const agentMap = useMemo(() => {
    const m: Record<string, { session_id: string; emoji: string; display_name: string }> = {}
    for (const a of agents) {
      m[a.session_id] = { session_id: a.session_id, emoji: a.emoji, display_name: a.display_name || a.profile_name }
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
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMutedCtx(m => !m)}
              className={`text-[10px] px-2 py-1 rounded-lg border transition-colors ${
                mutedCtx
                  ? 'text-zinc-600 border-zinc-800/50 hover:text-zinc-400 hover:border-zinc-700'
                  : 'text-emerald-500/70 border-zinc-800/50 hover:text-emerald-400 hover:border-zinc-700'
              }`}
            >
              CTX {mutedCtx ? '○' : '●'}
            </button>
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

      {/* Grid */}
      {agents.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-zinc-600">No agents running</p>
            <p className="text-xs text-zinc-700 mt-1">
              Start a session with <code className="text-accent-blue">ccd &lt;profile&gt;</code>
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
                {profileAgents.map((agent) => (
                  <AgentCard
                    key={agent.session_id}
                    agent={agent}
                    onClick={() => focusAgent(agent.session_id)}
                    mode={mode}
                    connectedAgents={connectedAgentsMap[agent.session_id]}
                    spriteOverride={spriteOverrides[agent.session_id]}
                    isReading={readingAgents.has(agent.session_id)}
                    hideSprite={hiddenSprites.has(agent.session_id)}
                    mutedCtx={mutedCtx}
                    cardRef={(el) => { if (el) cardRefs.current.set(agent.session_id, el); else cardRefs.current.delete(agent.session_id) }}
                  />
                ))}
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
          {sorted.map((agent) => (
            <AgentCard
              key={agent.session_id}
              agent={agent}
              onClick={() => focusAgent(agent.session_id)}
              mode={mode}
              connectedAgents={connectedAgentsMap[agent.session_id]}
              spriteOverride={spriteOverrides[agent.session_id]}
              isReading={readingAgents.has(agent.session_id)}
              hideSprite={hiddenSprites.has(agent.session_id)}
              mutedCtx={mutedCtx}
              cardRef={(el) => { if (el) cardRefs.current.set(agent.session_id, el); else cardRefs.current.delete(agent.session_id) }}
            />
          ))}
        </div>
      ) : (
        /* Compact: flat grid, minimal */
        <div
          className="flex-1 grid gap-2 min-h-0 content-start overflow-auto"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          }}
        >
          {sorted.map((agent) => (
            <AgentCard
              key={agent.session_id}
              agent={agent}
              onClick={() => focusAgent(agent.session_id)}
              mode={mode}
              connectedAgents={connectedAgentsMap[agent.session_id]}
              spriteOverride={spriteOverrides[agent.session_id]}
              isReading={readingAgents.has(agent.session_id)}
              hideSprite={hiddenSprites.has(agent.session_id)}
              mutedCtx={mutedCtx}
              cardRef={(el) => { if (el) cardRefs.current.set(agent.session_id, el); else cardRefs.current.delete(agent.session_id) }}
            />
          ))}
        </div>
      )}

      {/* Bottom bar — Messages + Activity tabs */}
      {(messages.length > 0 || activity.length > 0) && (
        <div className="shrink-0 mt-2 border-t border-zinc-800 pt-2">
          <div className="flex items-center gap-3 mb-1 px-0.5">
            <button
              onClick={() => setBottomTab('messages')}
              className={`text-[9px] uppercase tracking-wider ${bottomTab === 'messages' ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'}`}
            >
              Messages{messages.length > 0 ? ` (${messages.length})` : ''}
            </button>
            <button
              onClick={() => setBottomTab('activity')}
              className={`text-[9px] uppercase tracking-wider ${bottomTab === 'activity' ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'}`}
            >
              Activity{activity.length > 0 ? ` (${activity.length})` : ''}
            </button>
          </div>

          {bottomTab === 'messages' ? (
            <div ref={msgLogRef} className="max-h-28 overflow-y-auto overflow-x-hidden space-y-1">
              {messages.length === 0 ? (
                <div className="text-[10px] text-zinc-700 font-mono">No messages yet</div>
              ) : messages.map((msg) => {
                const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
                const fromSprite = spriteOverrides[msg.from] || POKEMON_SPRITES[hashString(msg.from) % POKEMON_SPRITES.length]
                const toSprite = spriteOverrides[msg.to] || POKEMON_SPRITES[hashString(msg.to) % POKEMON_SPRITES.length]
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
                const sprite = spriteOverrides[entry.session_id] || POKEMON_SPRITES[hashString(entry.session_id) % POKEMON_SPRITES.length]
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
          )}
        </div>
      )}

      <DeliveryOverlay deliveries={deliveries} />
      {showBrowser && <SessionBrowser onClose={() => setShowBrowser(false)} activeSessionIds={new Set(agents.map(a => a.session_id))} />}
    </div>
  )
}

