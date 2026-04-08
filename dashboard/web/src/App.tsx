import { useState, useEffect, useMemo, useRef } from 'react'
import { useSSE } from './hooks/useSSE'
import { useGridEngine } from './hooks/useGridEngine'
import { fetchSessions, focusAgent, fetchConnections, fetchSpriteOverrides, fetchMessageHistory, fetchActivity, fetchProfiles, fetchProjectList, fetchRoleList, launchProfile, shutdownAgent, dismissEphemeral, assignTaskGroup, ActivityEntry, ProfileInfo, ProjectInfo, RoleInfo } from './api'
import { AgentState, AgentConnection, AgentMessage } from './types'
import { AgentCard, GROUP_COLORS } from './components/AgentCard'
import { GridContainer } from './components/GridContainer'
import { GroupContainer } from './components/GroupContainer'
import { SessionBrowser } from './components/SessionBrowser'
import { hashString } from './components/CreatureIcon'
import { POKEMON_SPRITES } from './components/sprites'
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
  const settingsRef = useRef<HTMLDivElement>(null)
  const [spriteOverrides, setSpriteOverrides] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [bottomTab, setBottomTab] = useState<'messages' | 'activity'>('messages')
  const [bottomOpen, setBottomOpen] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const collapsedInitialized = useRef(false)
  const [groupViewModes, setGroupViewModes] = useState<Record<string, 'collapsed' | 'single' | 'expanded'>>(() => {
    try {
      return JSON.parse(localStorage.getItem('pokegents-group-view-modes') || '{}')
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

        if (inactive && age >= AUTO_COLLAPSE_MS && !manualExpandRef.current.has(a.session_id)) {
          toCollapse.push(a.session_id)
        }
        if (active) {
          toExpand.push(a.session_id)
          manualExpandRef.current.delete(a.session_id); persistManualExpand() // reset manual flag when agent becomes active
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
          const idx = members.findIndex(m => m.session_id === a.session_id)
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
  const groupSingleRects = useRef<Record<string, { w: number; h: number }>>({})
  const groupExpandedRects = useRef<Record<string, { w: number; h: number }>>({})
  // useMessageAnimations moved below getSpriteForId (needs it as dependency)
  // Layout computed after gridIds (below)
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
  const visibleUngrouped = useMemo(() => ungrouped.filter(a => !collapsedIds.has(a.session_id)), [ungrouped, collapsedIds])
  const collapsedAgents = useMemo(() => ungrouped.filter(a => collapsedIds.has(a.session_id)), [ungrouped, collapsedIds])

  const existingGroupNames = useMemo(() => Object.keys(grouped).sort(), [grouped])

  // Collapsed group names (rendered as bubbles, not grid items)
  const collapsedGroupNames = useMemo(() =>
    Object.keys(grouped).filter(g => (groupViewModes[g] || 'collapsed') === 'collapsed'),
    [grouped, groupViewModes]
  )

  // Grid IDs: open group virtual IDs + ungrouped agent IDs
  const gridIds = useMemo(() => {
    const ids: string[] = []
    for (const groupName of Object.keys(grouped).sort()) {
      if ((groupViewModes[groupName] || 'collapsed') !== 'collapsed') {
        ids.push(`group:${groupName}`)
      }
    }
    for (const a of visibleUngrouped) {
      ids.push(a.session_id)
    }
    return ids
  }, [grouped, visibleUngrouped, groupViewModes])

  const gridEngine = useGridEngine(gridIds, {
    rows: settings.gridRows,
    cols: settings.gridCols,
    defaultCardW: settings.defaultCardW ?? 2,
    defaultCardH: settings.defaultCardH ?? 2,
  })
  // Show header when cells are tall enough for standard mode
  const showHeader = gridEngine.cellH >= 140
  const isCompact = gridEngine.cellH < 120

  // Auto-adjust expanded group height when width changes (user manual resize)
  // Mental model: group height in grid units = cardRows * singleH (always exact)
  useEffect(() => {
    for (const [groupName, members] of Object.entries(grouped)) {
      if ((groupViewModes[groupName] || 'collapsed') !== 'expanded') continue
      const groupId = `group:${groupName}`
      const rect = gridEngine.layouts[groupId]
      const singleRect = groupSingleRects.current[groupName]
      if (!rect || !singleRect) continue

      const cols = Math.max(1, Math.floor(rect.w / singleRect.w))
      const rows = Math.ceil(members.length / cols)
      const neededH = rows * singleRect.h

      if (rect.h !== neededH) {
        gridEngine.resizeItem(groupId, rect.w, neededH)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridEngine.layouts, gridEngine.resizeState, grouped, groupViewModes])


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
  const agentInfoMap = useMemo(() => {
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


  // Agent lookup for rendering cards in GridContainer (includes all agents for group members)
  const agentMap = useMemo(() => {
    const m: Record<string, AgentState> = {}
    for (const a of agents) m[a.session_id] = a
    return m
  }, [agents])

  return (
    <>
    <div className="h-screen flex flex-col p-3 overflow-hidden relative z-10">
      {/* Header — hidden in compact mode */}
      {showHeader && (
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
                    const existingLayout = gridEngine.layouts[groupId]
                    const targetRect = existingLayout
                      ? gridEngine.gridRectToPixels(existingLayout)
                      : (() => {
                          const { defaultCardW: w, defaultCardH: h, cols } = gridEngine.settings
                          const occupied = { ...gridEngine.layouts }
                          for (let row = 1; row <= 100; row++) {
                            for (let col = 1; col <= cols - w + 1; col++) {
                              const candidate = { col, row, w, h }
                              const fits = !Object.values(occupied).some(r =>
                                r.col < candidate.col + candidate.w && r.col + r.w > candidate.col &&
                                r.row < candidate.row + candidate.h && r.row + r.h > candidate.row
                              )
                              if (fits) return gridEngine.gridRectToPixels(candidate)
                            }
                          }
                          return gridEngine.gridRectToPixels({ col: 1, row: 1, w, h })
                        })()
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
            const sprite = getSpriteForId(agent.session_id)
            return (
              <CollapsedBubble
                key={agent.session_id}
                agent={agent}
                sprite={sprite}
                bubbleRef={(el) => {
                  if (el) bubbleRefs.current.set(agent.session_id, el)
                  else bubbleRefs.current.delete(agent.session_id)
                }}
                onExpand={() => {
                  const bubbleEl = bubbleRefs.current.get(agent.session_id)
                  if (bubbleEl) {
                    const bubbleRect = bubbleEl.getBoundingClientRect()
                    const bubbleSource = {
                      x: bubbleRect.left + bubbleRect.width / 2,
                      y: bubbleRect.top + bubbleRect.height / 2,
                    }
                    // Compute where the card will land using grid engine
                    const existingLayout = gridEngine.layouts[agent.session_id]
                    const targetRect = existingLayout
                      ? gridEngine.gridRectToPixels(existingLayout)
                      : (() => {
                          // Estimate: place temporarily to get the position
                          const { defaultCardW: w, defaultCardH: h, cols } = gridEngine.settings
                          const occupied = { ...gridEngine.layouts }
                          for (let row = 1; row <= 100; row++) {
                            for (let col = 1; col <= cols - w + 1; col++) {
                              const candidate = { col, row, w, h }
                              const fits = !Object.values(occupied).some(r =>
                                r.col < candidate.col + candidate.w && r.col + r.w > candidate.col &&
                                r.row < candidate.row + candidate.h && r.row + r.h > candidate.row
                              )
                              if (fits) return gridEngine.gridRectToPixels(candidate)
                            }
                          }
                          return gridEngine.gridRectToPixels({ col: 1, row: 1, w, h })
                        })()
                    const doExpand = () => {
                      manualExpandRef.current.add(agent.session_id); persistManualExpand()
                      setCollapsedIds(prev => { const next = new Set(prev); next.delete(agent.session_id); return next })
                    }
                    triggerDeploy(agent.session_id, sprite, bubbleSource, targetRect, () => {}, doExpand)
                  } else {
                    manualExpandRef.current.add(agent.session_id); persistManualExpand()
                    setCollapsedIds(prev => { const next = new Set(prev); next.delete(agent.session_id); return next })
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
              onClick={() => gridEngine.compactUp()}
              className="gba-button text-[7px] font-pixel px-3 py-1.5 transition-colors"
              title="Move cards up to fill gaps"
            >
              TIDY UP
            </button>
            <button
              onClick={() => gridEngine.resetSizes()}
              className="gba-button text-[7px] font-pixel px-3 py-1.5 transition-colors"
              title="Reset all cards to default size"
            >
              RESET
            </button>
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
            // Group container
            if (id.startsWith('group:')) {
              const groupName = id.slice(6)
              const members = grouped[groupName]
              if (!members) return null
              const pixelW = rect.w * gridEngine.cellW + (rect.w - 1) * 8
              const pixelH = rect.h * gridEngine.cellH + (rect.h - 1) * 8
              const sr = groupSingleRects.current[groupName]
              const singleCardPixelW = sr ? sr.w * gridEngine.cellW + (sr.w - 1) * 8 : undefined
              const singleCardPixelH = sr ? sr.h * gridEngine.cellH + (sr.h - 1) * 8 : undefined
              return (
                <GroupContainer
                  name={groupName}
                  members={members}
                  viewMode={(groupViewModes[groupName] === 'expanded' ? 'expanded' : 'single')}
                  pageIndex={groupPageIndex[groupName] || 0}
                  onSetViewMode={(mode) => {
                    setGroupViewModes(prev => ({ ...prev, [groupName]: mode }))
                    if (mode === 'expanded') {
                      // Save single-view rect as card unit
                      groupSingleRects.current[groupName] = { w: rect.w, h: rect.h }
                      // Restore previous expanded config if available
                      const saved = groupExpandedRects.current[groupName]
                      const sr = groupSingleRects.current[groupName] || { w: rect.w, h: rect.h }
                      if (saved) {
                        // Clamp width to available space at current position
                        const maxW = gridEngine.settings.cols - rect.col + 1
                        const clampedW = Math.min(saved.w, maxW)
                        if (clampedW !== saved.w) {
                          // Recalculate height: more rows needed since fewer columns
                          const savedCols = Math.max(1, Math.floor(saved.w / sr.w))
                          const newCols = Math.max(1, Math.floor(clampedW / sr.w))
                          const savedRows = Math.ceil(members.length / savedCols)
                          const newRows = Math.ceil(members.length / newCols)
                          const newH = Math.round(saved.h * newRows / savedRows)
                          gridEngine.resizeItem(id, clampedW, newH)
                        } else {
                          gridEngine.resizeItem(id, saved.w, saved.h)
                        }
                      } else {
                        // Default: single column, height = memberCount * singleH
                        gridEngine.resizeItem(id, rect.w, members.length * rect.h)
                      }
                    } else if (mode === 'single') {
                      // Save expanded rect for next time
                      groupExpandedRects.current[groupName] = { w: rect.w, h: rect.h }
                      // Restore single-view rect
                      const sr = groupSingleRects.current[groupName]
                      if (sr) {
                        gridEngine.resizeItem(id, sr.w, sr.h)
                      } else {
                        gridEngine.resizeItem(id, rect.w, gridEngine.settings.defaultCardH)
                      }
                    }
                  }}
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
                  cols={rect.w}
                  cardMode={cardMode}
                  pixelW={pixelW}
                  pixelH={pixelH}
                  singleCardPixelW={singleCardPixelW}
                  singleCardPixelH={singleCardPixelH}
                  spriteOverrides={spriteOverrides}
                  resolveToSpriteId={resolveToSpriteId}
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
            return (
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
                onDismiss={agent.ephemeral ? () => dismissEphemeral(agent.session_id) : undefined}
                existingGroups={existingGroupNames}
                onCollapse={() => {
                  const cardEl = cardRefs.current.get(agent.session_id)
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
                    const sprite = getSpriteForId(agent.session_id)
                    const existingBubbles = bubbleRefs.current.size
                    const bubbleTarget = { x: 12 + existingBubbles * 36 + 16, y: showHeader ? 56 : 16 }
                    triggerRecall(agent.session_id, sprite, animRect, bubbleTarget, () => {
                      setCollapsedIds(prev => new Set([...prev, agent.session_id]))
                    }, { spriteCx, spriteCy })
                  } else {
                    setCollapsedIds(prev => new Set([...prev, agent.session_id]))
                  }
                }}
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
            )
          }}
        </GridContainer>
      )}

      </div>{/* ← end ROOT flex container */}

      {/* Bottom bar — Messages + Activity tabs (fixed, outside flex) */}
      {(messages.length > 0 || activity.length > 0) && (
        <div className="fixed bottom-0 left-0 right-0 z-30 border-t-2 border-gba-teal-dark pt-2 pb-2 px-3" style={{ background: 'linear-gradient(180deg, rgba(42,104,88,0.95) 0%, rgba(42,104,88,1) 30%)' }}>
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
      <PokeballAnimationLayer animations={animations} onComplete={onAnimComplete} />
      {showBrowser && <SessionBrowser
        onClose={() => setShowBrowser(false)}
        activeSessionIds={new Set(agents.map(a => a.session_id))}
        onResume={(id) => setCollapsedIds(prev => { const next = new Set(prev); next.delete(id); return next })}
      />}
      {showLauncher && <LaunchModal projects={projects} roles={roles} agents={agents} onClose={() => setShowLauncher(false)} />}
    </>
  )
}

