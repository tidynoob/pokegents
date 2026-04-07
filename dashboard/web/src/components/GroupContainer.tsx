import { useState, useRef, useEffect } from 'react'
import { AgentState } from '../types'
import { AgentCard, GROUP_COLORS } from './AgentCard'
import { hashString } from './CreatureIcon'
import { focusAgent, releaseTaskGroup, ProjectInfo, RoleInfo } from '../api'
import type { CardMode } from '../hooks/useGridEngine'

export type GroupViewMode = 'collapsed' | 'single' | 'expanded'

interface GroupContainerProps {
  name: string
  members: AgentState[]
  viewMode: 'single' | 'expanded'  // collapsed is handled as a bubble, not rendered here
  pageIndex: number
  onSetViewMode: (mode: GroupViewMode) => void
  onSetPageIndex: (index: number) => void
  onMinimize: () => void
  cols: number
  cardMode: CardMode
  pixelW: number
  pixelH: number
  singleCardPixelW?: number
  singleCardPixelH?: number
  spriteOverrides: Record<string, string>
  resolveToSpriteId: (id: string) => string
  readingAgents: Set<string>
  projects: ProjectInfo[]
  roles: RoleInfo[]
}

function statusDotColor(state: string): string {
  if (state === 'busy') return '#e87848'
  if (state === 'error' || state === 'needs_input') return '#d84848'
  return '#58a868'
}

function sortMembers(members: AgentState[]): AgentState[] {
  return [...members].sort((a, b) => {
    const aCoord = a.role?.toLowerCase().includes('coordinator') ? 0 : 1
    const bCoord = b.role?.toLowerCase().includes('coordinator') ? 0 : 1
    if (aCoord !== bCoord) return aCoord - bCoord
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
}

const HEADER_H = 40

export function GroupContainer({
  name, members: rawMembers, viewMode, pageIndex, onSetViewMode, onSetPageIndex, onMinimize,
  cols, cardMode, pixelW, pixelH, singleCardPixelW, singleCardPixelH,
  spriteOverrides, resolveToSpriteId, readingAgents, projects, roles,
}: GroupContainerProps) {
  const [confirmRelease, setConfirmRelease] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }
  }, [])

  const handleRelease = () => {
    if (!confirmRelease) {
      setConfirmRelease(true)
      confirmTimer.current = setTimeout(() => setConfirmRelease(false), 3000)
      return
    }
    setConfirmRelease(false)
    releaseTaskGroup(name)
  }

  const idx = Math.abs(hashString(name)) % GROUP_COLORS.length
  const [r, g, b] = GROUP_COLORS[idx]
  const members = sortMembers(rawMembers)
  const safePageIndex = Math.min(pageIndex, members.length - 1)
  const contentH = pixelH - HEADER_H
  // Use single-view width as card unit for column layout
  const innerCardW = singleCardPixelW || pixelW
  // Card height computed dynamically: fill available space evenly
  const INNER_GAP = 8
  const PAD = 8 // px-1 + pb-1
  const subCols = innerCardW < pixelW ? Math.max(1, Math.floor((pixelW - PAD) / innerCardW)) : 1
  const cardRows = Math.ceil(members.length / subCols)
  const innerCardH = cardRows > 0 ? Math.floor((contentH - PAD - (cardRows - 1) * INNER_GAP) / cardRows) : 180

  const renderCard = (agent: AgentState) => (
    <AgentCard
      key={agent.session_id}
      agent={agent}
      onClick={() => focusAgent(agent.session_id)}
      mode={cardMode}
      spriteOverride={spriteOverrides[resolveToSpriteId(agent.session_id)] || spriteOverrides[agent.session_id]}
      spriteSessionId={resolveToSpriteId(agent.session_id)}
      isReading={readingAgents.has(agent.session_id)}
      projects={projects}
      roles={roles}
    />
  )

  return (
    <div
      className="rounded-lg h-full flex flex-col overflow-hidden min-w-0"
      style={{
        background: `rgba(${r}, ${g}, ${b}, 0.10)`,
        border: `1px solid rgba(${r}, ${g}, ${b}, 0.40)`,
        borderLeft: `3px solid rgba(${r}, ${g}, ${b}, 0.75)`,
      }}
    >
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 select-none shrink-0" style={{ height: HEADER_H }}>
        {/* Left side: expand toggle */}
        <button
          className="text-[11px] text-white/50 hover:text-white/80 transition-colors px-0.5"
          onClick={(e) => { e.stopPropagation(); onSetViewMode(viewMode === 'single' ? 'expanded' : 'single') }}
          title={viewMode === 'single' ? 'Expand all' : 'Single view'}
        >{viewMode === 'single' ? '▶' : '▼'}</button>

        <span
          className="text-[8px] font-pixel pixel-shadow uppercase truncate"
          style={{ color: `rgb(${r}, ${g}, ${b})` }}
        >{name}</span>
        <span className="text-[8px] font-pixel text-white/40 shrink-0">
          {viewMode === 'single'
            ? `${safePageIndex + 1}/${members.length}`
            : `${members.length}`}
        </span>

        <div className="flex items-center gap-1 ml-auto" onClick={e => e.stopPropagation()}>
          {/* Single mode: pagination arrows */}
          {viewMode === 'single' && (
            <>
              <button
                className="text-[10px] text-white/40 hover:text-white/80 transition-colors disabled:text-white/15 px-1"
                onClick={() => onSetPageIndex(Math.max(0, safePageIndex - 1))}
                disabled={safePageIndex === 0}
              >◀</button>
              <button
                className="text-[10px] text-white/40 hover:text-white/80 transition-colors disabled:text-white/15 px-1"
                onClick={() => onSetPageIndex(Math.min(members.length - 1, safePageIndex + 1))}
                disabled={safePageIndex >= members.length - 1}
              >▶</button>
            </>
          )}

          {/* Status dots */}
          {members.map(m => (
            <span
              key={m.session_id}
              className={`inline-block w-1.5 h-1.5 rounded-full${m.state === 'busy' ? ' animate-pulse' : ''}`}
              style={{ background: statusDotColor(m.state) }}
              title={`${m.display_name || m.profile_name}: ${m.state}`}
            />
          ))}

          {/* Release group (shutdown all agents) */}
          <button
            className={`h-3.5 rounded-full transition-colors flex items-center justify-center text-[8px] font-bold text-white leading-none ml-1 px-1 ${
              confirmRelease
                ? 'bg-red-500 hover:bg-red-400 min-w-[52px]'
                : 'w-3.5 bg-white/10 hover:bg-red-500/60'
            }`}
            style={{ boxShadow: '1px 1px 0 rgba(0,0,0,0.3)' }}
            onClick={(e) => { e.stopPropagation(); handleRelease() }}
            title={confirmRelease ? 'Click again to release all agents' : 'Release group'}
          >{confirmRelease ? 'Release?' : '×'}</button>

          {/* Minimize to bubble */}
          <button
            className="w-3.5 h-3.5 rounded-full bg-accent-red/60 hover:bg-accent-red/80 transition-colors flex items-center justify-center text-[8px] font-bold text-white leading-none ml-1"
            style={{ boxShadow: '1px 1px 0 rgba(0,0,0,0.3)' }}
            onClick={onMinimize}
            title="Minimize"
          >−</button>
        </div>
      </div>

      {/* Single mode: one card + dot indicators */}
      {viewMode === 'single' && contentH > 0 && (
        <div className="flex-1 flex flex-col min-h-0 min-w-0 px-1 pb-1">
          <div className="flex-1 min-h-0 min-w-0">
            {members[safePageIndex] && renderCard(members[safePageIndex])}
          </div>
          {members.length > 1 && (
            <div className="flex items-center justify-center gap-1 pt-1 shrink-0">
              {members.map((m, i) => (
                <button
                  key={m.session_id}
                  className="transition-all"
                  onClick={() => onSetPageIndex(i)}
                  title={m.display_name || m.profile_name}
                >
                  <span
                    className="inline-block rounded-full transition-all"
                    style={{
                      width: i === safePageIndex ? 6 : 4,
                      height: i === safePageIndex ? 6 : 4,
                      background: i === safePageIndex ? `rgb(${r}, ${g}, ${b})` : statusDotColor(m.state),
                      opacity: i === safePageIndex ? 1 : 0.5,
                    }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Expanded mode: sub-grid of all cards */}
      {viewMode === 'expanded' && contentH > 0 && (
        <div
          className="flex-1 min-h-0 min-w-0 overflow-hidden px-1 pb-1"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(200, innerCardW - 16)}px, 1fr))`,
            gap: 8,
            alignContent: 'start',
          }}
        >
          {members.map(agent => (
            <div key={agent.session_id} className="min-w-0" style={{ height: innerCardH }}>
              {renderCard(agent)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
