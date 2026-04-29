import { useState, useEffect, useMemo, useRef } from 'react'
import { useSSE } from './hooks/useSSE'
import { useGridEngine } from './hooks/useGridEngine'
import { fetchSessions, focusAgent, fetchConnections, fetchMessageHistory, fetchActivity, fetchProfiles, fetchProjectList, fetchRoleList, shutdownAgent, dismissEphemeral, assignTaskGroup, ActivityEntry, ProfileInfo, ProjectInfo, RoleInfo } from './api'
import { AgentState, AgentConnection, AgentMessage, stableId } from './types'
import { AgentCard, GROUP_COLORS } from './components/AgentCard'
import { GridContainer } from './components/GridContainer'
import { GroupContainer } from './components/GroupContainer'
import { SessionBrowser } from './components/SessionBrowser'
import { TownView } from './components/TownView'
import { ChatPanel } from './components/ChatPanel'
import { hashString } from './components/CreatureIcon'
import { useMessageAnimations, DeliveryOverlay } from './components/MessageAnimations'
import { useSettings } from './hooks/useSettings'
import { SettingsPanel } from './components/SettingsPanel'
import { LaunchModal } from './components/LaunchModal'
import { PokeballAnimationLayer, usePokeballAnimations } from './components/PokeballAnimation'

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

function CollapsedBubble({ agent, sprite, onExpand, bubbleRef }: {
  agent: AgentState; sprite: string; onExpand: () => void
  bubbleRef?: (el: HTMLDivElement | null) => void
}) {
  const [hovered, setHovered] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const st = STATUS_PILLS[agent.state] || STATUS_PILLS.idle
  const dur = formatInactive(agent.last_updated)

  return (
    <div
      ref={(el) => { ref.current = el; bubbleRef?.(el) }}
      className="relative"
      onMouseEnter={() => { hoverTimer.current = setTimeout(() => setHovered(true), 300) }}
      onMouseLeave={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(false) }}
    >
      <button
        onClick={() => { setHovered(false); onExpand() }}
        className="relative flex items-center justify-center group" style={{ width: 32, height: 32 }}
        title={`${agent.display_name} — click to expand`}
      >
        <img
          src="/sprites/pokeball.png"
          alt=""
          className="absolute opacity-50 group-hover:opacity-80 transition-opacity"
          style={{ imageRendering: 'pixelated', width: 32, height: 32 }}
        />
        <img
          src={`/sprites/${sprite}.png`}
          alt=""
          className="relative z-10"
          style={{ imageRendering: 'pixelated', transform: 'scale(0.8)', filter: 'grayscale(0.4) brightness(0.8)', transition: 'filter 0.15s' }}
          onMouseEnter={e => { (e.target as HTMLImageElement).style.filter = 'grayscale(0) brightness(1)' }}
          onMouseLeave={e => { (e.target as HTMLImageElement).style.filter = 'grayscale(0.4) brightness(0.8)' }}
        />
      </button>

      {/* Hover preview card */}
      {hovered && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 pointer-events-none"
          style={{ animation: 'fadeIn 0.15s ease' }}
        >
          <div className="gba-card rounded-lg px-3 py-2.5 border border-white/10 min-w-[180px] max-w-[220px]"
            style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.6)' }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <img src={`/sprites/${sprite}.png`} alt="" style={{ imageRendering: 'pixelated', width: 28, height: 28 }} />
              <div className="flex-1 min-w-0">
                <div className="text-[8px] font-pixel text-white pixel-shadow truncate">{agent.display_name}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className={`text-[5px] font-pixel text-white px-1 py-px rounded-full leading-none ${st.pulse ? 'animate-pulse-soft' : ''}`}
                    style={{ backgroundColor: st.bg, textShadow: '1px 1px 0 rgba(0,0,0,0.4)' }}
                  >{st.label}</span>
                  {dur && <span className="text-[6px] font-mono text-white/30">{dur}</span>}
                </div>
              </div>
            </div>
            {agent.detail && (
              <div className="text-[7px] font-mono text-white/50 truncate mt-1 border-t border-white/10 pt-1">{agent.detail}</div>
            )}
            {agent.user_prompt && (
              <div className="text-[7px] font-mono text-white/35 truncate mt-1">{agent.user_prompt.slice(0, 80)}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CollapsedGroupBubble({ name, members, sprite, onExpand, bubbleRef }: {
  name: string; members: AgentState[]; sprite: string; onExpand: () => void
  bubbleRef?: (el: HTMLDivElement | null) => void
}) {
  const [hovered, setHovered] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const idx = Math.abs(hashString(name)) % GROUP_COLORS.length
  const [r, g, b] = GROUP_COLORS[idx]

  return (
    <div
      ref={(el) => { ref.current = el; bubbleRef?.(el) }}
      className="relative"
      onMouseEnter={() => { hoverTimer.current = setTimeout(() => setHovered(true), 300) }}
      onMouseLeave={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(false) }}
    >
      <button
        onClick={() => { setHovered(false); onExpand() }}
        className="relative flex items-center justify-center group" style={{ width: 32, height: 32 }}
        title={`${name} — ${members.length} agents — click to open`}
      >
        <img
          src="/sprites/pokeball.png"
          alt=""
          className="absolute opacity-50 group-hover:opacity-80 transition-opacity"
          style={{ imageRendering: 'pixelated', width: 32, height: 32 }}
        />
        <img
          src={`/sprites/${sprite}.png`}
          alt=""
          className="relative z-10"
          style={{ imageRendering: 'pixelated', transform: 'scale(0.8)', filter: 'grayscale(0.4) brightness(0.8)', transition: 'filter 0.15s' }}
          onMouseEnter={e => { (e.target as HTMLImageElement).style.filter = 'grayscale(0) brightness(1)' }}
          onMouseLeave={e => { (e.target as HTMLImageElement).style.filter = 'grayscale(0.4) brightness(0.8)' }}
        />
        {/* Count badge */}
        <span
          className="absolute -bottom-1 -right-1.5 z-20 text-[5px] font-pixel text-white rounded-full px-0.5 leading-tight"
          style={{ background: `rgb(${r},${g},${b})`, textShadow: '1px 1px 0 rgba(0,0,0,0.5)' }}
        >{members.length}</span>
      </button>

      {/* Hover tooltip */}
      {hovered && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 pointer-events-none"
          style={{ animation: 'fadeIn 0.15s ease' }}
        >
          <div className="gba-card rounded-lg px-3 py-2 border border-white/10 min-w-[140px] max-w-[200px]"
            style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.6)' }}
          >
            <div className="text-[8px] font-pixel pixel-shadow uppercase mb-1" style={{ color: `rgb(${r},${g},${b})` }}>{name}</div>
            {members.map(m => {
              const st = STATUS_PILLS[m.state] || STATUS_PILLS.idle
              return (
                <div key={m.session_id} className="flex items-center gap-1.5 py-0.5">
                  <span
                    className={`text-[5px] font-pixel text-white px-1 py-px rounded-full leading-none ${st.pulse ? 'animate-pulse-soft' : ''}`}
                    style={{ backgroundColor: st.bg, textShadow: '1px 1px 0 rgba(0,0,0,0.4)' }}
                  >{st.label}</span>
                  <span className="text-[7px] font-pixel text-white/60 truncate">{m.display_name || m.profile_name}</span>
                </div>
              )
            })}
          </div>
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
  // chatAgentId is the pokegent_id of the chat-backed agent whose ChatPanel
  // is open on the right. Persisted across reloads so the panel re-opens.
  const [chatAgentId, setChatAgentId] = useState<string | null>(() => {
    try { return localStorage.getItem('pokegents-chat-agent') || null } catch { return null }
  })
  useEffect(() => {
    try {
      if (chatAgentId) localStorage.setItem('pokegents-chat-agent', chatAgentId)
      else localStorage.removeItem('pokegents-chat-agent')
    } catch { /* ignore */ }
  }, [chatAgentId])
  // Auto-open ChatPanel when an agent is migrated to chat — fired by AgentCard.
  // Also fires on re-click of the same chat card (the card's inner output area
  // stopPropagates, so the GridCell's onClick never reaches App — everything
  // routes through this custom event instead).
  const chatAgentIdRef = useRef(chatAgentId)
  chatAgentIdRef.current = chatAgentId
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { pokegentId?: string }
      if (!detail?.pokegentId) return
      if (chatAgentIdRef.current === detail.pokegentId) {
        // Same agent re-clicked — ping the panel to flash.
        window.dispatchEvent(new Event('chat-panel-ping'))
      } else {
        setChatAgentId(detail.pokegentId)
      }
    }
    window.addEventListener('open-chat-panel', handler)
    return () => window.removeEventListener('open-chat-panel', handler)
  }, [])
  // Auto-close the chat panel when the targeted agent is no longer chat-backed.
  // Covers two cases: (1) user migrated away from chat → we should close the
  // panel; (2) localStorage has a stale chatAgentId from a previous session
  // pointing at an iterm2 agent → don't render an SSE-subscribed panel that
  // 404s. We only clear AFTER the agents list has loaded so a transient
  // empty agentMap on first paint doesn't nuke a valid chat panel.
  useEffect(() => {
    if (!chatAgentId || agents.length === 0) return
    const target = agents.find(a =>
      (a.pokegent_id && a.pokegent_id === chatAgentId) ||
      a.session_id === chatAgentId,
    )
    if (target && target.interface !== 'chat') setChatAgentId(null)
  }, [chatAgentId, agents])
  // Resizable chat panel — drag the divider between grid and panel to reflow.
  // Persisted to localStorage so the user's preferred width survives reloads.
  const [chatPanelWidth, setChatPanelWidth] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('pokegents-chat-panel-width') || '', 10)
      if (Number.isFinite(v) && v >= 280 && v <= 1400) return v
    } catch { /* ignore */ }
    return 520
  })
  useEffect(() => {
    try { localStorage.setItem('pokegents-chat-panel-width', String(chatPanelWidth)) } catch { /* ignore */ }
  }, [chatPanelWidth])
  const dragWidthRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const onChatDividerPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    dragWidthRef.current = { startX: e.clientX, startWidth: chatPanelWidth }
    const onMove = (ev: PointerEvent) => {
      const ref = dragWidthRef.current
      if (!ref) return
      // Drag right → divider moves right → panel shrinks (its left edge moves right).
      // Convention: width = startWidth - dx (so dragging RIGHT makes panel narrower).
      const dx = ev.clientX - ref.startX
      const next = Math.max(280, Math.min(window.innerWidth - 200, ref.startWidth - dx))
      setChatPanelWidth(next)
    }
    const onUp = () => {
      dragWidthRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // CMD-hold overlay: shows numbered shortcuts on agent cards.
  // CMD+1..9 opens the chat panel for that agent. We used to also show a
  // dimming "⌘1, ⌘2…" overlay over each card while Meta was held; that was
  // removed because Cmd is the modifier for macOS screenshots (Cmd+Shift+4)
  // and the overlay flashed onto every card the moment you held Cmd, ruining
  // captures.
  const gridIdsRef = useRef<string[]>([])
  const agentMapRef = useRef<Record<string, AgentState>>({})
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      // CMD+1..9 → open agent at that grid position
      if (e.metaKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        const ids = gridIdsRef.current
        const agentIds = ids.filter(id => !id.startsWith('town') && !id.startsWith('group:'))
        const targetId = agentIds[idx]
        if (targetId) {
          const agent = agentMapRef.current[targetId]
          if (agent?.interface === 'chat') {
            setChatAgentId(targetId)
          } else if (agent) {
            focusAgent(targetId)
          }
        }
      }
    }
    window.addEventListener('keydown', onDown)
    return () => {
      window.removeEventListener('keydown', onDown)
    }
  }, [])
  const settingsRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [bottomTab, setBottomTab] = useState<'messages' | 'activity'>('messages')
  const [bottomOpen, setBottomOpen] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const collapsedInitialized = useRef(false)
  // 'expanded' was supported when groups could span multiple grid cells. In
  // flow mode every cell is 1×1, so expanded is gone — any persisted value of
  // 'expanded' is silently treated as 'single'.
  const [groupViewModes, setGroupViewModes] = useState<Record<string, 'collapsed' | 'single'>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('pokegents-group-view-modes') || '{}')
      const out: Record<string, 'collapsed' | 'single'> = {}
      for (const [k, v] of Object.entries(raw)) {
        out[k] = v === 'collapsed' ? 'collapsed' : 'single'
      }
      return out
    } catch { return {} }
  })
  const [groupPageIndex, setGroupPageIndex] = useState<Record<string, number>>({})
  const { animations, triggerRecall, triggerDeploy, onComplete: onAnimComplete } = usePokeballAnimations()
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const [showLauncher, setShowLauncher] = useState(false)
  const [gridSliderDragging, setGridSliderDragging] = useState(false)

  // Restore from localStorage AFTER first agents load (so we know which IDs are valid)
  useEffect(() => {
    if (collapsedInitialized.current || agents.length === 0) return
    collapsedInitialized.current = true
    try {
      const saved: string[] = JSON.parse(localStorage.getItem('pokegents-collapsed') || '[]')
      const validIds = new Set(agents.map(a => stableId(a)))
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

  // Persist group view modes
  useEffect(() => {
    localStorage.setItem('pokegents-group-view-modes', JSON.stringify(groupViewModes))
  }, [groupViewModes])

  // Auto-collapse new groups on first appearance (seed existing groups on first load)
  const knownGroupsRef = useRef<Set<string>>(new Set())
  const knownGroupsInitialized = useRef(false)
  useEffect(() => {
    const currentGroups = new Set(agents.filter(a => a.task_group).map(a => a.task_group!))
    if (!knownGroupsInitialized.current && currentGroups.size > 0) {
      knownGroupsInitialized.current = true
      knownGroupsRef.current = currentGroups
      return // don't treat existing groups as new on first load
    }
    for (const g of currentGroups) {
      if (!knownGroupsRef.current.has(g)) {
        knownGroupsRef.current.add(g)
        setGroupViewModes(prev => ({ ...prev, [g]: 'collapsed' }))
      }
    }
  }, [agents])

  // Track manually expanded agents so auto-collapse doesn't immediately re-collapse them
  const manualExpandRef = useRef<Set<string>>(
    (() => { try { return new Set<string>(JSON.parse(localStorage.getItem('pokegents-manual-expand') || '[]')) } catch { return new Set<string>() } })()
  )

  const persistManualExpand = () => {
    localStorage.setItem('pokegents-manual-expand', JSON.stringify([...manualExpandRef.current]))
  }

  // Auto-collapse after 15 min of inactivity (idle/done only), auto-expand when busy/needs_input
  useEffect(() => {
    if (!collapsedInitialized.current || agents.length === 0 || settings.autoCollapseMinutes === 0) return
    const AUTO_COLLAPSE_MS = settings.autoCollapseMinutes * 60 * 1000

    const check = () => {
      const now = Date.now()
      const toCollapse: string[] = []
      const toExpand: string[] = []

      for (const a of agents) {
        // Skip grouped agents — they're managed by GroupContainer, not pokéball collapse
        if (a.task_group) continue
        const age = a.last_updated ? now - new Date(a.last_updated).getTime() : 0
        const inactive = a.state === 'idle' || a.state === 'done'
        const active = a.state === 'busy' || a.state === 'needs_input'

        const aid = stableId(a)
        if (inactive && age >= AUTO_COLLAPSE_MS && !manualExpandRef.current.has(aid)) {
          toCollapse.push(aid)
        }
        if (active) {
          toExpand.push(aid)
          manualExpandRef.current.delete(aid); persistManualExpand() // reset manual flag when agent becomes active
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

      // Auto-expand groups when any member enters needs_input → switch to 'single' at that agent
      const groupUpdates: Record<string, number> = {}
      for (const a of agents) {
        if (a.state === 'needs_input' && a.task_group &&
            (groupViewModes[a.task_group] || 'collapsed') === 'collapsed') {
          // Find index of this agent in its group
          const members = agents.filter(m => m.task_group === a.task_group)
          const idx = members.findIndex(m => stableId(m) === stableId(a))
          groupUpdates[a.task_group] = Math.max(idx, 0)
        }
      }
      if (Object.keys(groupUpdates).length > 0) {
        setGroupViewModes(prev => {
          const next = { ...prev }
          for (const g of Object.keys(groupUpdates)) next[g] = 'single'
          return next
        })
        setGroupPageIndex(prev => ({ ...prev, ...groupUpdates }))
      }
    }

    check()
    const iv = setInterval(check, 30000)
    return () => clearInterval(iv)
  }, [agents, settings.autoCollapseMinutes, groupViewModes])

  const msgLogRef = useRef<HTMLDivElement>(null)
  const actLogRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  // useMessageAnimations moved below getSpriteForId (needs it as dependency)
  // Layout computed after gridIds (below)
  // showHeader computed after layout (below)

  useEffect(() => {
    fetchSessions().then(setAgents).catch(() => {})
    fetchConnections().then(setConnections).catch(() => {})
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

  // Split agents into grouped and ungrouped
  const { grouped, ungrouped } = useMemo(() => {
    const grouped: Record<string, AgentState[]> = {}
    const ungrouped: AgentState[] = []
    agents.forEach(a => {
      if (a.task_group) {
        (grouped[a.task_group] ??= []).push(a)
      } else {
        ungrouped.push(a)
      }
    })
    // Sort ephemeral agents to appear immediately after their parent.
    // Helper: reorder a list so ephemerals follow their parent
    function sortWithEphemerals(list: AgentState[]): AgentState[] {
      const result: AgentState[] = []
      const ephByParent: Record<string, AgentState[]> = {}
      for (const a of list) {
        if (a.ephemeral && a.parent_session_id) {
          (ephByParent[a.parent_session_id] ??= []).push(a)
        }
      }
      for (const a of list) {
        if (a.ephemeral) continue
        result.push(a)
        const children = ephByParent[a.session_id] || ephByParent[a.ccd_session_id || ''] || []
        result.push(...children)
      }
      // Append orphaned ephemerals at the end
      for (const a of list) {
        if (a.ephemeral && !result.includes(a)) result.push(a)
      }
      return result
    }
    // Apply to both grouped and ungrouped
    for (const key of Object.keys(grouped)) {
      grouped[key] = sortWithEphemerals(grouped[key])
    }
    return { grouped, ungrouped: sortWithEphemerals(ungrouped) }
  }, [agents])

  // Ungrouped: filter collapsed for pokéball bubbles
  const visibleUngrouped = useMemo(() => ungrouped.filter(a => !collapsedIds.has(stableId(a))), [ungrouped, collapsedIds])
  const collapsedAgents = useMemo(() => ungrouped.filter(a => collapsedIds.has(stableId(a))), [ungrouped, collapsedIds])

  const existingGroupNames = useMemo(() => Object.keys(grouped).sort(), [grouped])

  // Collapsed group names (rendered as bubbles, not grid items)
  const collapsedGroupNames = useMemo(() =>
    Object.keys(grouped).filter(g => (groupViewModes[g] || 'collapsed') === 'collapsed'),
    [grouped, groupViewModes]
  )

  // Grid IDs: town (optional) + open group virtual IDs + ungrouped agent IDs.
  const gridIds = useMemo(() => {
    const ids: string[] = []
    if (settings.showTownCard) ids.push('town')
    for (const groupName of Object.keys(grouped).sort()) {
      if ((groupViewModes[groupName] || 'collapsed') !== 'collapsed') {
        ids.push(`group:${groupName}`)
      }
    }
    for (const a of visibleUngrouped) {
      ids.push(stableId(a))
    }
    return ids
  }, [grouped, visibleUngrouped, groupViewModes, settings.showTownCard])

  // Flow-grid density knobs. Cards are uniform 1×1 cells; cardsPerRow drives
  // CSS grid columns, cardsPerCol determines how many rows fit before scroll.
  // Drag reorders the array; the rest just falls out of CSS.
  const gridEngine = useGridEngine(gridIds, {
    cardsPerRow: settings.cardsPerRow ?? 3,
    cardsPerCol: settings.cardsPerCol ?? 3,
    gap: settings.cardGap ?? 8,
  })
  // Keep gridIdsRef in sync for the CMD+N keydown handler closure.
  // Use effectiveOrder (visual grid order) not gridIds (insertion order).
  const visualOrder = gridEngine.effectiveOrder
  useEffect(() => { gridIdsRef.current = visualOrder }, [visualOrder])

  // Show header when cells are tall enough for standard mode
  const showHeader = gridEngine.cellH >= 140
  const isCompact = gridEngine.cellH < 120


  const getSpriteForId = useMemo(() => {
    const m: Record<string, string> = {}
    for (const a of agents) {
      if (a.sprite) {
        m[a.session_id] = a.sprite
        if (a.ccd_session_id) m[a.ccd_session_id] = a.sprite
        if (a.pokegent_id) m[a.pokegent_id] = a.sprite
      }
    }
    return (id: string) => m[id] || 'pokeball'
  }, [agents])

  const { deliveries, hiddenSprites, readingAgents, triggerTestDelivery } = useMessageAnimations(messages, cardRefs, getSpriteForId)

  // Build a map of session_id / pokegent_id → connected agent info (for icons)
  const agentInfoMap = useMemo(() => {
    const m: Record<string, { session_id: string; emoji: string; display_name: string }> = {}
    for (const a of agents) {
      m[a.session_id] = { session_id: a.session_id, emoji: a.emoji, display_name: a.display_name || a.profile_name }
      if (a.ccd_session_id && a.ccd_session_id !== a.session_id) {
        m[a.ccd_session_id] = m[a.session_id]
      }
      if (a.pokegent_id && a.pokegent_id !== a.session_id && a.pokegent_id !== a.ccd_session_id) {
        m[a.pokegent_id] = m[a.session_id]
      }
    }
    return m
  }, [agents])

  const connectedAgentsMap = useMemo(() => {
    const map: Record<string, { session_id: string; emoji: string; display_name: string }[]> = {}
    for (const conn of connections) {
      const a = agentInfoMap[conn.agent_a]
      const b = agentInfoMap[conn.agent_b]
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
  }, [connections, agentInfoMap])

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


  // Agent lookup for rendering cards in GridContainer — keyed by stableId (pokegent_id)
  // and also by session_id for backward compat with grid layouts saved before migration
  const agentMap = useMemo(() => {
    const m: Record<string, AgentState> = {}
    for (const a of agents) {
      m[stableId(a)] = a
      if (a.session_id !== stableId(a)) m[a.session_id] = a
    }
    return m
  }, [agents])
  // Keep agentMapRef in sync for the CMD+N keydown handler.
  useEffect(() => { agentMapRef.current = agentMap }, [agentMap])

  return (
    <>
    <div className="h-screen flex flex-col p-3 overflow-hidden relative z-10">
      {/* Header — always visible */}
      {(
        <div className="flex items-center shrink-0 mb-2">
          <div className="flex items-center gap-3">
            <h1 className="text-[10px] font-pixel text-white pixel-shadow">POKéGENTS</h1>
            <span className="text-[8px] font-pixel text-white/50">
              {agents.length - collapsedAgents.length} active{collapsedAgents.length > 0 && <>, {collapsedAgents.length} idle</>}
              <span className={`ml-1.5 ${connected ? 'text-accent-green' : 'text-accent-red'}`}>●</span>
            </span>
          </div>
          {/* Collapsed pokeballs + group bubbles inline */}
          {(collapsedAgents.length > 0 || collapsedGroupNames.length > 0) && (
            <div className="flex items-center gap-1.5 ml-6">
          {/* Group bubbles */}
          {collapsedGroupNames.map(groupName => {
            const members = grouped[groupName] || []
            const coord = members.find(m => m.role?.toLowerCase().includes('coordinator'))
            const primaryAgent = coord || members[0]
            const sprite = primaryAgent ? getSpriteForId(primaryAgent.session_id) : 'pokeball'
            return (
              <CollapsedGroupBubble
                key={`group:${groupName}`}
                name={groupName}
                members={members}
                sprite={sprite}
                bubbleRef={(el) => {
                  if (el) bubbleRefs.current.set(`group:${groupName}`, el)
                  else bubbleRefs.current.delete(`group:${groupName}`)
                }}
                onExpand={() => {
                  const bubbleEl = bubbleRefs.current.get(`group:${groupName}`)
                  if (bubbleEl) {
                    const bubbleRect = bubbleEl.getBoundingClientRect()
                    const bubbleSource = {
                      x: bubbleRect.left + bubbleRect.width / 2,
                      y: bubbleRect.top + bubbleRect.height / 2,
                    }
                    const groupId = `group:${groupName}`
                    // Card lands at its current index in the flow order — or
                    // at the end if not yet placed. Either way it's a single
                    // 1×1 cell, so the geometry is just (col, row) from index.
                    const cpr = gridEngine.settings.cardsPerRow
                    const idx = gridEngine.indexOf(groupId)
                    const landingIdx = idx >= 0 ? idx : gridEngine.order.length
                    const targetRect = gridEngine.gridRectToPixels({
                      col: (landingIdx % cpr) + 1,
                      row: Math.floor(landingIdx / cpr) + 1,
                      w: 1, h: 1,
                    })
                    triggerDeploy(groupId, sprite, bubbleSource, targetRect, () => {},
                      () => setGroupViewModes(prev => ({ ...prev, [groupName]: 'single' })))
                  } else {
                    setGroupViewModes(prev => ({ ...prev, [groupName]: 'single' }))
                  }
                }}
              />
            )
          })}
          {collapsedAgents.map(agent => {
            const aid = stableId(agent)
            const sprite = getSpriteForId(aid)
            return (
              <CollapsedBubble
                key={aid}
                agent={agent}
                sprite={sprite}
                bubbleRef={(el) => {
                  if (el) bubbleRefs.current.set(aid, el)
                  else bubbleRefs.current.delete(aid)
                }}
                onExpand={() => {
                  const bubbleEl = bubbleRefs.current.get(aid)
                  if (bubbleEl) {
                    const bubbleRect = bubbleEl.getBoundingClientRect()
                    const bubbleSource = {
                      x: bubbleRect.left + bubbleRect.width / 2,
                      y: bubbleRect.top + bubbleRect.height / 2,
                    }
                    // Card lands at its current index in the flow order — or
                    // at the end if not yet placed. Either way it's a 1×1.
                    const cpr = gridEngine.settings.cardsPerRow
                    const idx = gridEngine.indexOf(aid)
                    const landingIdx = idx >= 0 ? idx : gridEngine.order.length
                    const targetRect = gridEngine.gridRectToPixels({
                      col: (landingIdx % cpr) + 1,
                      row: Math.floor(landingIdx / cpr) + 1,
                      w: 1, h: 1,
                    })
                    const doExpand = () => {
                      manualExpandRef.current.add(aid); persistManualExpand()
                      setCollapsedIds(prev => { const next = new Set(prev); next.delete(aid); return next })
                    }
                    triggerDeploy(aid, sprite, bubbleSource, targetRect, () => {}, doExpand)
                  } else {
                    manualExpandRef.current.add(aid); persistManualExpand()
                    setCollapsedIds(prev => { const next = new Set(prev); next.delete(aid); return next })
                  }
                }}
              />
            )
          })}
            </div>
          )}
          <div className="flex-1" />
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
                  onGridDragging={setGridSliderDragging}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Body: grid (left) + optional ChatPanel (right split-pane) */}
      <div className="flex-1 min-h-0 flex gap-3">
       <div className="flex-1 min-w-0 flex flex-col">
      {agents.length === 0 && !settings.showTownCard ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="gba-dialog text-center px-8 py-6">
            <p className="text-[9px] font-pixel text-gba-dialog-border">No POKéMON in party</p>
            <p className="text-[7px] font-pixel text-gba-dialog-border/60 mt-3">
              Start with <span className="text-gba-card">pokegents &lt;profile&gt;</span>
            </p>
          </div>
        </div>
      ) : (
        <GridContainer
          engine={gridEngine}
          agentIds={gridIds}
          showHeader={showHeader}
          showGridLines={gridSliderDragging}
          onDropOnGroup={async (agentId, groupName) => {
            await assignTaskGroup(agentId, groupName)
          }}
        >
          {(id, rect, cardMode) => {
            // Town card — special grid item that renders the live town map.
            // Wrapped in gba-card so it has the same blue chrome as agent cards
            // instead of floating naked on the page background.
            if (id === 'town') {
              return (
                <div
                  className="gba-card h-full w-full flex items-center justify-center overflow-hidden"
                  style={{ padding: 'var(--card-padding, 16px)' }}
                  data-no-drag-children="false"
                >
                  <TownView
                    agents={agents}
                    onSelect={(a) => focusAgent(stableId(a))}
                    selectedId={null}
                    debug={settings.townDebug}
                  />
                </div>
              )
            }
            // Group container
            if (id.startsWith('group:')) {
              const groupName = id.slice(6)
              const members = grouped[groupName]
              if (!members) return null
              // All cells are 1×1 in flow mode, so the group's pixel size is
              // just one cell. Expanded view-mode is gone — groups always
              // render in single mode (active card + compact member list).
              const pixelW = gridEngine.cellW
              const pixelH = gridEngine.cellH
              return (
                <GroupContainer
                  name={groupName}
                  members={members}
                  viewMode="single"
                  pageIndex={groupPageIndex[groupName] || 0}
                  onSetViewMode={() => { /* expand-in-grid is gone */ }}
                  onSetPageIndex={(idx) => setGroupPageIndex(prev => ({ ...prev, [groupName]: idx }))}
                  onMinimize={() => {
                    const coord = members.find(m => m.role?.toLowerCase().includes('coordinator'))
                    const primaryAgent = coord || members[0]
                    const groupSprite = primaryAgent ? getSpriteForId(primaryAgent.session_id) : 'pokeball'
                    const cardRect = gridEngine.gridRectToPixels(rect)
                    const spriteCx = cardRect.left + cardRect.width / 2
                    const spriteCy = cardRect.top + 40
                    const existingBubbles = bubbleRefs.current.size
                    const bubbleTarget = { x: 12 + existingBubbles * 36 + 16, y: showHeader ? 56 : 16 }
                    triggerRecall(`group:${groupName}`, groupSprite, cardRect, bubbleTarget, () => {
                      setGroupViewModes(prev => ({ ...prev, [groupName]: 'collapsed' }))
                    }, { spriteCx, spriteCy })
                  }}
                  cols={1}
                  cardMode={cardMode}
                  pixelW={pixelW}
                  pixelH={pixelH}
                  readingAgents={readingAgents}
                  projects={projects}
                  roles={roles}
                  existingGroups={existingGroupNames}
                />
              )
            }

            // Regular agent card
            const agent = agentMap[id]
            if (!agent) return null
            const aid = stableId(agent)
            const isChat = agent.interface === 'chat'
            const isActiveChatTarget = isChat && chatAgentId === aid
            return (
              <AgentCard
                agent={agent}
                onClick={() => {
                  if (isChat) {
                    if (chatAgentId === aid) {
                      // Same agent re-clicked — ping the panel to flash.
                      window.dispatchEvent(new Event('chat-panel-ping'))
                    } else {
                      setChatAgentId(aid)
                    }
                  } else {
                    focusAgent(aid)
                  }
                }}
                glowActive={isActiveChatTarget}
                mode={cardMode}
                connectedAgents={connectedAgentsMap[aid] || connectedAgentsMap[agent.session_id]}
                spriteOverride={agent.sprite}
                isReading={readingAgents.has(aid) || readingAgents.has(agent.session_id)}
                hideSprite={hiddenSprites.has(aid) || hiddenSprites.has(agent.session_id)}
                projects={projects}
                roles={roles}
                onDismiss={agent.ephemeral ? () => dismissEphemeral(aid) : undefined}
                existingGroups={existingGroupNames}
                onCollapse={() => {
                  const cardEl = cardRefs.current.get(aid)
                  if (cardEl) {
                    const spriteEl = cardEl.querySelector('.creature-sprite') as HTMLElement | null
                    const spriteRect = spriteEl?.getBoundingClientRect()
                    const cardRect = spriteRect
                      ? new DOMRect(cardEl.getBoundingClientRect().left, cardEl.getBoundingClientRect().top,
                          cardEl.getBoundingClientRect().width, cardEl.getBoundingClientRect().height)
                      : cardEl.getBoundingClientRect()
                    const animRect = new DOMRect(
                      cardRect.left, cardRect.top, cardRect.width, cardRect.height
                    )
                    const spriteCx = spriteRect ? spriteRect.left + spriteRect.width / 2 : cardRect.left + cardRect.width - 40
                    const spriteCy = spriteRect ? spriteRect.top + spriteRect.height / 2 : cardRect.top + 32
                    const sprite = getSpriteForId(aid)
                    const existingBubbles = bubbleRefs.current.size
                    const bubbleTarget = { x: 12 + existingBubbles * 36 + 16, y: showHeader ? 56 : 16 }
                    triggerRecall(aid, sprite, animRect, bubbleTarget, () => {
                      setCollapsedIds(prev => new Set([...prev, aid]))
                    }, { spriteCx, spriteCy })
                  } else {
                    setCollapsedIds(prev => new Set([...prev, aid]))
                  }
                }}
                cardRef={(el) => {
                  if (el) {
                    cardRefs.current.set(aid, el)
                  } else {
                    cardRefs.current.delete(aid)
                  }
                }}
              />
            )
          }}
        </GridContainer>
      )}
       </div>{/* end grid column */}

       {/* Right split-pane: always present so grid doesn't resize when toggling chat.
           Shows ChatPanel when an agent is selected, empty placeholder otherwise. */}
       {/* Resize handle */}
       <div
         role="separator"
         aria-orientation="vertical"
         title="Drag to resize chat panel"
         onPointerDown={onChatDividerPointerDown}
         className="group/divider shrink-0 -mx-1.5 px-1 cursor-col-resize relative z-20 select-none"
         style={{ width: 6 }}
       >
         <div className="h-full w-px mx-auto bg-white/10 group-hover/divider:bg-accent-blue transition-colors" />
       </div>
       <div className="shrink-0 min-h-0" style={{ width: chatPanelWidth }}>
         {(() => {
           const chatAgent = chatAgentId ? agentMap[chatAgentId] : null
           if (chatAgent) {
             return <ChatPanel agent={chatAgent} onClose={() => setChatAgentId(null)} />
           }
           return (
             <div className="h-full w-full flex items-center justify-center gba-card" style={{ borderRadius: 8, background: 'linear-gradient(180deg, #3a78b0 0%, #2e6498 30%, #1f4878 100%)' }}>
               <div className="text-center text-white/30">
                 <div className="text-[8px] font-pixel pixel-shadow">No agent selected</div>
                 <div className="text-[7px] font-pixel mt-1">Click a chat agent to open</div>
               </div>
             </div>
           )
         })()}
       </div>
      </div>{/* end body flex-row */}

      {/* Bottom bar — Messages + Activity tabs. Lives inside the root flex
          column as a shrink-0 child so the body's flex-1 sizing accounts
          for it (grid cell-height calc + chat panel both respect it). */}
      {(messages.length > 0 || activity.length > 0) && (
        <div className="shrink-0 -mx-3 -mb-3 mt-2 border-t-2 border-gba-teal-dark pt-2 pb-2 px-3 z-30" style={{ background: 'linear-gradient(180deg, rgba(42,104,88,0.95) 0%, rgba(42,104,88,1) 30%)' }}>
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

      </div>{/* ← end ROOT flex container (now AFTER bottom bar so flex-1 body respects it) */}

      <DeliveryOverlay deliveries={deliveries} />
      <PokeballAnimationLayer animations={animations} onComplete={onAnimComplete} />
      {showBrowser && <SessionBrowser
        onClose={() => setShowBrowser(false)}
        activePokegentIds={new Set(agents.map(a => stableId(a)))}
        onResume={(id) => setCollapsedIds(prev => { const next = new Set(prev); next.delete(id); return next })}
      />}
      {showLauncher && <LaunchModal projects={projects} roles={roles} agents={agents} onClose={() => setShowLauncher(false)} />}
    </>
  )
}
