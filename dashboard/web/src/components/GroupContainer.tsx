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
  viewMode: 'single' | 'expanded'
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
  readingAgents: Set<string>
  projects: ProjectInfo[]
  roles: RoleInfo[]
  existingGroups?: string[]
}

function statusColor(state: string): string {
  if (state === 'busy') return '#e87848'
  if (state === 'needs_input') return '#d84848'
  if (state === 'error') return '#a858a8'
  if (state === 'done') return '#58a868'
  return '#788890'
}

function statusLabel(state: string): string {
  if (state === 'busy') return 'ATK'
  if (state === 'needs_input') return 'WAIT'
  if (state === 'error') return 'PSN'
  if (state === 'done') return 'OK'
  return 'SLP'
}

function formatTime(lastUpdated?: string): string {
  if (!lastUpdated) return ''
  const secs = Math.max(0, (Date.now() - new Date(lastUpdated).getTime()) / 1000)
  if (secs < 60) return `${Math.floor(secs)}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`
}

function sortMembers(members: AgentState[]): AgentState[] {
  return [...members].sort((a, b) => {
    const aCoord = a.role?.toLowerCase().includes('coordinator') ? 0 : 1
    const bCoord = b.role?.toLowerCase().includes('coordinator') ? 0 : 1
    if (aCoord !== bCoord) return aCoord - bCoord
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
}

function getSprite(agent: AgentState): string {
  return agent.sprite || 'pokeball'
}

const HEADER_H = 32

/** Compact 1-row member entry: sprite + name + status pill + time */
function MemberRow({ agent, sprite, isActive, onClick }: {
  agent: AgentState; sprite: string; isActive: boolean; onClick: () => void
}) {
  const time = formatTime(agent.last_updated)
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 w-full px-1.5 py-0.5 rounded transition-colors ${isActive ? 'bg-white/10' : 'hover:bg-white/5'}`}
      style={{ minHeight: 20 }}
    >
      <img
        src={`/sprites/${sprite}.png`}
        alt=""
        style={{ width: 16, height: 16, imageRendering: 'pixelated', flexShrink: 0 }}
      />
      <span className="text-[7px] font-pixel text-white/70 truncate flex-1 text-left">
        {agent.display_name || agent.profile_name}
      </span>
      <span
        className={`text-[5px] font-pixel text-white px-1 py-px rounded-full leading-none shrink-0${agent.state === 'busy' ? ' animate-pulse-soft' : ''}`}
        style={{ backgroundColor: statusColor(agent.state), textShadow: '1px 1px 0 rgba(0,0,0,0.4)' }}
      >{statusLabel(agent.state)}</span>
      {time && <span className="text-[6px] font-mono text-white/25 shrink-0">{time}</span>}
    </button>
  )
}

export function GroupContainer({
  name, members: rawMembers, viewMode, pageIndex, onSetViewMode, onSetPageIndex, onMinimize,
  cols, cardMode, pixelW, pixelH, singleCardPixelW, singleCardPixelH,
  readingAgents, projects, roles, existingGroups,
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
  const innerCardW = singleCardPixelW || pixelW
  const INNER_GAP = 8
  const PAD = 8
  const subCols = innerCardW < pixelW ? Math.max(1, Math.floor((pixelW - PAD) / innerCardW)) : 1
  const cardRows = Math.ceil(members.length / subCols)
  const innerCardH = cardRows > 0 ? Math.floor((contentH - PAD - (cardRows - 1) * INNER_GAP) / cardRows) : 180

  const renderCard = (agent: AgentState) => (
    <AgentCard
      key={agent.session_id}
      agent={agent}
      onClick={() => focusAgent(agent.session_id)}
      mode={cardMode}
      spriteOverride={agent.sprite}
      isReading={readingAgents.has(agent.session_id)}
      projects={projects}
      roles={roles}
      existingGroups={existingGroups}
    />
  )

  // Other members (not the active one) for the compact list
  const otherMembers = members.filter((_, i) => i !== safePageIndex)

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
      <div className="flex items-center gap-2 px-2.5 select-none shrink-0" style={{ height: HEADER_H }}>
        <button
          className="text-[9px] text-white/50 hover:text-white/80 transition-colors px-0.5"
          onClick={(e) => { e.stopPropagation(); onSetViewMode(viewMode === 'single' ? 'expanded' : 'single') }}
          title={viewMode === 'single' ? 'Expand all' : 'Single view'}
        >{viewMode === 'single' ? '▶' : '▼'}</button>

        <span
          className="text-[7px] font-pixel pixel-shadow uppercase truncate"
          style={{ color: `rgb(${r}, ${g}, ${b})` }}
        >{name}</span>
        <span className="text-[7px] font-pixel text-white/40 shrink-0">{members.length}</span>

        <div className="flex items-center gap-1 ml-auto" onClick={e => e.stopPropagation()}>
          {/* Single mode: pagination arrows */}
          {viewMode === 'single' && (
            <>
              <button
                className="text-[9px] text-white/40 hover:text-white/80 transition-colors disabled:text-white/15 px-0.5"
                onClick={() => onSetPageIndex(Math.max(0, safePageIndex - 1))}
                disabled={safePageIndex === 0}
              >◀</button>
              <button
                className="text-[9px] text-white/40 hover:text-white/80 transition-colors disabled:text-white/15 px-0.5"
                onClick={() => onSetPageIndex(Math.min(members.length - 1, safePageIndex + 1))}
                disabled={safePageIndex >= members.length - 1}
              >▶</button>
            </>
          )}

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

          <button
            className="w-3 h-3 rounded-full bg-accent-red/60 hover:bg-accent-red/80 transition-colors flex items-center justify-center text-[7px] font-bold text-white leading-none ml-1"
            style={{ boxShadow: '1px 1px 0 rgba(0,0,0,0.3)' }}
            onClick={onMinimize}
            title="Minimize"
          >−</button>
        </div>
      </div>

      {/* Single mode: active card + compact member list */}
      {viewMode === 'single' && contentH > 0 && (
        <div className="flex-1 flex flex-col min-h-0 min-w-0 px-1 pb-1 gap-1">
          {/* Active agent card */}
          <div className="flex-1 min-h-0 min-w-0">
            {members[safePageIndex] && renderCard(members[safePageIndex])}
          </div>

          {/* Compact member list — other agents */}
          {otherMembers.length > 0 && (
            <div className="shrink-0 flex flex-col gap-px overflow-y-auto" style={{ maxHeight: Math.min(otherMembers.length * 22, 88) }}>
              {otherMembers.map((m) => {
                const sprite = getSprite(m)
                const memberIdx = members.findIndex(x => x.session_id === m.session_id)
                return (
                  <MemberRow
                    key={m.session_id}
                    agent={m}
                    sprite={sprite}
                    isActive={false}
                    onClick={() => onSetPageIndex(memberIdx)}
                  />
                )
              })}
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
