import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AgentState } from '../types'
import { CreatureIcon, hashString } from './CreatureIcon'
import { focusAgent, setSprite, sendPrompt, ProjectInfo, RoleInfo } from '../api'
import { SpritePicker } from './SpritePicker'
import { BusyBubble, DoneBubble, ReadingIndicator } from './MessageAnimations'
import { useSpriteAnimation } from './spriteAnimations'
import { PromptInput } from './PromptInput'
import { AgentMenu } from './AgentMenu'
import { StateBadge, AgentLifecycleState } from './StateBadge'
import { formatElapsed } from '../utils/elapsed'
import { renderMiniMarkdown } from '../utils/miniMarkdown'
import { useRuntimeCapabilities, capsFor } from '../utils/runtimes'
import { useAgentRename } from '../hooks/useAgentRename'
import { useAgentState } from '../hooks/useAgentState'

export function ProfilePill({ name, color }: { name: string; color?: [number, number, number] }) {
  const [r, g, b] = color || [100, 100, 100]
  return (
    <span
      className="text-[6px] font-pixel text-white rounded-sm px-1.5 py-px pixel-shadow shrink-0 uppercase"
      style={{ background: `rgba(${r}, ${g}, ${b}, 0.6)`, border: `1px solid rgba(${r}, ${g}, ${b}, 0.8)` }}
    >{name}</span>
  )
}

export function RolePill({ name }: { name: string }) {
  return (
    <span className="text-[6px] font-pixel text-white rounded-sm px-1.5 py-px pixel-shadow shrink-0 uppercase"
      style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.2)' }}
    >{name}</span>
  )
}

export const GROUP_COLORS: [number, number, number][] = [
  [168, 80, 200],  // purple
  [80, 168, 200],  // teal
  [200, 140, 60],  // amber
  [100, 180, 100], // green
  [200, 80, 120],  // rose
  [80, 120, 200],  // blue
]

export function TaskGroupPill({ name }: { name: string }) {
  const idx = Math.abs(hashString(name)) % GROUP_COLORS.length
  const [r, g, b] = GROUP_COLORS[idx]
  return (
    <span
      className="text-[6px] font-pixel text-white rounded-sm px-1.5 py-px pixel-shadow shrink-0 uppercase"
      style={{ background: `rgba(${r}, ${g}, ${b}, 0.6)`, border: `1px solid rgba(${r}, ${g}, ${b}, 0.8)` }}
    >{name}</span>
  )
}

function SubagentPill({ type }: { type?: string }) {
  return (
    <span
      className="text-[6px] font-pixel text-white rounded-sm px-1.5 py-px pixel-shadow shrink-0 uppercase"
      style={{ background: 'rgba(120, 180, 255, 0.6)', border: '1px solid rgba(120, 180, 255, 0.8)' }}
    >{type || 'subagent'}</span>
  )
}

export function HealthBar({ tokens, window: ctxWindow }: { tokens: number; window: number }) {
  if (!ctxWindow && !tokens) {
    return (
      <div className="flex items-center gap-1.5 mt-1">
                <span className="text-[7px] font-pixel font-bold text-accent-yellow pixel-shadow shrink-0">HP</span>
        <div className="flex-1 h-[6px] gba-hp-bar" />
        <span className="text-[7px] font-pixel text-white/30 shrink-0">—</span>
      </div>
    )
  }

  const usage = tokens / (ctxWindow || 1000000)
  const hp = Math.max(0, Math.min(100, (1 - usage) * 100))

  let color = '#58d898'  // GBA green
  if (hp < 20) color = '#f85858'  // GBA red
  else if (hp < 50) color = '#f8d830'  // GBA yellow

  const usedK = Math.round(tokens / 1000)
  const totalK = Math.round(ctxWindow / 1000)

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span className="text-[7px] font-pixel font-bold text-accent-yellow pixel-shadow shrink-0">HP</span>
      <div className="flex-1 h-[6px] gba-hp-bar overflow-hidden">
        <div
          className="h-full transition-all duration-1000"
          style={{ width: `${hp}%`, background: `linear-gradient(180deg, ${color} 0%, ${color}cc 100%)` }}
        />
      </div>
      <span className="text-[7px] font-mono text-white/60 pixel-shadow shrink-0 tabular-nums">{usedK}/{totalK}</span>
    </div>
  )
}

type LayoutMode = 'standard' | 'compact' | 'compact-minimal'

interface AgentCardProps {
  agent: AgentState
  onClick: () => void
  mode: LayoutMode
  connectedAgents?: { session_id: string; emoji: string; display_name: string }[]
  spriteOverride?: string
  isReading?: boolean
  hideSprite?: boolean
  onCollapse?: () => void
  onDismiss?: () => void
  cardRef?: (el: HTMLDivElement | null) => void
  projects?: ProjectInfo[]
  roles?: RoleInfo[]
  existingGroups?: string[]
  /** When true, shows a brief accent-blue glow ring to indicate this card's
   *  chat panel is active on the right. */
  glowActive?: boolean
}

const HIDE_DETAILS = new Set(['finished', 'session started', 'processing prompt'])

function SpriteAnimWrapper({ state, compact, children }: { state: string; compact: boolean; children: React.ReactNode }) {
  const animClass = useSpriteAnimation(state, !compact)
  // "celebrating" state uses a continuous hop, not the cycling system
  if (!compact && state === 'celebrating') {
    return <div className="relative sprite-hop-loop">{children}</div>
  }
  return <div className={`relative ${compact ? '' : animClass}`}>{children}</div>
}

export function AgentCard({ agent, onClick, mode, connectedAgents, spriteOverride, isReading, hideSprite, onCollapse, onDismiss, cardRef, projects, roles, existingGroups, glowActive }: AgentCardProps) {
  const compact = mode === 'compact' || mode === 'compact-minimal'
  const showPrompt = mode === 'standard'
  const showInput = mode !== 'compact-minimal'
  const outputH = 'flex-1 min-h-[40px]'
  const title = agent.display_name || agent.profile_name || 'Agent'
  const showDetail = agent.detail && !HIDE_DETAILS.has(agent.detail)
  const [r, g, b] = agent.color
  const agentState = useAgentState(agent)
  const { isBusy, isError, isIdle } = agentState
  const isDone = false // Phase 2: done collapsed into idle
  const ageSeconds = agent.last_updated ? (Date.now() - new Date(agent.last_updated).getTime()) / 1000 : 0
  const isCompacting = agent.detail === 'compacting'
  const outputText = isCompacting ? null : (isBusy ? agent.last_trace : agent.last_summary)

  const rename = useAgentRename(agent.session_id, title)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [showSpritePicker, setShowSpritePicker] = useState(false)
  const [flashDismissed, setFlashDismissed] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const allCaps = useRuntimeCapabilities()
  const caps = capsFor(allCaps, agent.interface)

  useEffect(() => {
    if (rename.isRenaming) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [rename.isRenaming])

  // Reset flash dismissed when agent starts a new turn
  useEffect(() => {
    if (isBusy) setFlashDismissed(false)
  }, [isBusy])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
    setMenuOpen(true)
  }

  const iconSize = compact ? 20 : 32
  const textSize = 'text-[10px]'
  // In compact mode padding stays tight — there's not enough vertical space
  // for the user's preferred padding. Standard mode honours --card-padding.
  const cardStyle: React.CSSProperties = compact
    ? { padding: '6px 8px' }
    : { padding: 'var(--card-padding, 10px)' }

  return (
    <>
      <div
        ref={cardRef ? (el) => cardRef(el) : undefined}
        onContextMenu={handleContextMenu}
        className={`text-left cursor-default overflow-visible flex flex-col h-full transition-all duration-300 relative group ${
          isBusy ? 'gba-card-selected' : 'gba-card'
        } ${agent.ephemeral ? 'opacity-80' : ''}`}
        style={{
          ...cardStyle,
          ...(agent.ephemeral ? { borderStyle: 'dashed' } : {}),
          ...(glowActive ? { boxShadow: '0 0 0 2px rgba(248,216,48,0.6), 0 0 16px rgba(248,216,48,0.2)' } : {}),
        }}
        onMouseEnter={() => {
          if (isDone && !flashDismissed) setFlashDismissed(true)
        }}
      >
        {/* Done flash — pulses for 1 minute after completion, dismissed on hover */}
        {isDone && !isIdle && ageSeconds < 60 && !flashDismissed && (
          <div
            className="card-done-flash absolute inset-0 rounded-lg pointer-events-none group-hover:hidden"
            style={{ background: 'rgba(88, 216, 152, 0.15)' }}
          />
        )}

        {/* Toast overlay */}
        {toast && (
          <div className="absolute inset-0 rounded-lg flex items-center justify-center pointer-events-none z-20" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <span className="text-[7px] font-pixel text-accent-yellow pixel-shadow">{toast}</span>
          </div>
        )}

        {/* Minimize button — pokeball style in top-right corner */}
        {onCollapse && (
          <div className="absolute top-0 right-0 w-[10%] h-[15%] z-10 group/corner">
            <button
              onClick={(e) => { e.stopPropagation(); onCollapse() }}
              className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-accent-red hover:bg-accent-red/80 opacity-0 group-hover/corner:opacity-100 transition-opacity flex items-center justify-center text-[8px] font-bold text-white leading-none"
              style={{ boxShadow: '1px 1px 0 rgba(0,0,0,0.3)' }}
              title="Collapse"
            >
              −
            </button>
          </div>
        )}

        {/* Dismiss button for completed ephemeral subagents */}
        {onDismiss && agent.ephemeral && isDone && (
          <div className="absolute top-0 right-0 w-[10%] h-[15%] z-10 group/corner">
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss() }}
              className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-white/20 hover:bg-white/40 opacity-0 group-hover/corner:opacity-100 transition-opacity flex items-center justify-center text-[8px] font-bold text-white leading-none"
              style={{ boxShadow: '1px 1px 0 rgba(0,0,0,0.3)' }}
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {/* Header: icon + name + status */}
        <div className={`flex items-center ${compact ? 'gap-1.5 mb-1' : 'gap-3 mb-2'} shrink-0`}>
          {/* Click sprite → change sprite */}
          <div
            onClick={(e) => { e.stopPropagation(); setShowSpritePicker(true) }}
            className="cursor-pointer hover:brightness-125 relative overflow-visible"
            style={{ width: iconSize, height: iconSize }}
          >
            {/* Static background box */}
            {!compact && <div className="absolute inset-0 bg-black/20 rounded-lg" />}
            {/* Animated sprite + bubbles */}
            <SpriteAnimWrapper state={isDone && !isIdle && ageSeconds < 60 && !flashDismissed ? 'celebrating' : agent.state} compact={compact}>
              <div style={{ opacity: hideSprite ? 0 : 1, transition: 'opacity 0.15s' }}>
                <CreatureIcon sessionId={agent.session_id} size={iconSize} noGlow={compact} doneFlash={false} spriteOverride={spriteOverride} noBg />
              </div>
              {!compact && <BusyBubble isBusy={isBusy} />}
              {!compact && <DoneBubble isDone={isDone} />}
              <ReadingIndicator isReading={!!isReading} />
            </SpriteAnimWrapper>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                {/* Click name → rename */}
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
                    onClick={(e) => e.stopPropagation()}
                    className={`${compact ? 'text-[7px]' : 'text-[8px]'} font-pixel text-white bg-transparent border-b border-white/50 outline-none w-full pixel-shadow`}
                  />
                ) : (
                  <h3
                    className={`${compact ? 'text-[7px]' : 'text-[8px]'} font-pixel text-white truncate cursor-pointer hover:text-accent-yellow pixel-shadow`}
                    onClick={(e) => { e.stopPropagation(); rename.startRename() }}
                  >
                    {title}
                  </h3>
                )}
                <HealthBar tokens={agent.context_tokens} window={agent.context_window} />
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                {!compact && (
                  <>
                    <div className="flex items-center gap-1">
                      <StateBadge state={(agent.state || 'idle') as AgentLifecycleState} busySince={agent.busy_since} compact />
                      {agentState.backgroundTasks > 0 && (
                        <span className="text-[10px] text-amber-400/80 ml-1">
                          {agentState.backgroundTasks} bg
                        </span>
                      )}
                    </div>
                    {agent.ephemeral && <SubagentPill type={agent.subagent_type} />}
                    {agent.task_group && <TaskGroupPill name={agent.task_group} />}
                    {agent.role && <RolePill name={agent.role} />}
                    {!agent.ephemeral && <ProfilePill name={agent.project || agent.profile_name} color={agent.project_color || agent.color} />}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Last prompt — shown in standard modes */}
        {showPrompt && agent.user_prompt && (
          <div
            className="rounded-md px-3 py-0.5 mb-1 shrink-0 overflow-hidden"
            style={{ background: 'rgba(0, 0, 0, 0.40)', boxShadow: 'inset 1px 1px 0 rgba(0,0,0,0.4)', fontSize: 'var(--output-font-size, 11px)' }}
          >
            <div className="font-mono text-white/50 truncate leading-snug">
              <span className="text-amber-300/60 mr-1">&gt;</span>
              {agent.user_prompt}
            </div>
          </div>
        )}

        {/* Output box — always present, content switches based on state */}
        <ActivityBox
          agent={agent}
          isBusy={isBusy}
          isDone={isDone}
          isError={isError}
          isCompacting={isCompacting}
          outputText={outputText}
          compact={compact}
          outputH={outputH}
          textSize={textSize}
        />
        {/* Quick command input */}
        {showInput && (
          <PromptInput
            sessionId={agent.session_id}
            onSend={(text) => sendPrompt(agent.session_id, text)}
            variant="card"
            maxHeight={80}
          />
        )}
      </div>

      {/* Right-click context menu */}
      {menuOpen && createPortal(
        <AgentMenu
          x={menuPos.x}
          y={menuPos.y}
          agent={agent}
          capabilities={caps}
          onClose={() => setMenuOpen(false)}
          onRename={() => { setMenuOpen(false); rename.startRename() }}
          onChangeSprite={() => { setMenuOpen(false); setShowSpritePicker(true) }}
          onCollapse={onCollapse}
          projects={projects}
          roles={roles}
          existingGroups={existingGroups}
          onAssignStatus={(msg) => { setToast(msg); setTimeout(() => setToast(null), 2500) }}
        />,
        document.body
      )}

      {/* Sprite picker */}
      {showSpritePicker && createPortal(
        <SpritePicker
          currentSprite={agent.sprite || 'pokeball'}
          onSelect={async (sprite) => { await setSprite(agent.session_id, sprite) }}
          onClose={() => setShowSpritePicker(false)}
        />,
        document.body
      )}
    </>
  )
}

function ActivityBox({ agent, isBusy, isDone, isError, isCompacting, outputText, compact, outputH, textSize }: {
  agent: AgentState; isBusy: boolean; isDone: boolean; isError: boolean; isCompacting: boolean;
  outputText: string | null; compact: boolean; outputH: string; textSize: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const feed = agent.activity_feed
  const [, setTick] = useState(0)

  // Auto-scroll to bottom when feed updates
  useEffect(() => {
    if (scrollRef.current && isBusy) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [feed?.length, isBusy])

  // Tick timer every 1s for elapsed display
  useEffect(() => {
    if (isBusy) return
    const iv = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(iv)
  }, [isBusy])

  const elapsed = !isBusy && agent.last_updated ? formatElapsed(agent.last_updated) + ' ago' : ''

  return (
    <div className={`relative ${outputH}`}>
      <div
        ref={scrollRef}
        data-no-drag
        className={`rounded-md ${compact ? 'px-2 py-1.5' : 'px-3 py-2'} h-full overflow-y-auto overflow-x-hidden cursor-pointer hover:brightness-110`}
        style={{ background: 'rgba(0, 0, 0, 0.45)', boxShadow: 'inset 1px 1px 0 rgba(0,0,0,0.4)', fontSize: 'var(--output-font-size, 11px)' }}
        onClick={(e) => {
          e.stopPropagation()
          // Route by interface — chat-backed agents don't have an iTerm tab to
          // focus, so open the chat panel via the same CustomEvent the migrate
          // flow uses. iTerm2 agents fall through to focusAgent as before.
          if (agent.interface === 'chat') {
            window.dispatchEvent(new CustomEvent('open-chat-panel', {
              detail: { pokegentId: agent.pokegent_id || agent.session_id },
            }))
          } else {
            focusAgent(agent.session_id)
          }
        }}
      >
      {isCompacting ? (
        <div className="font-mono text-accent-yellow/80 animate-pulse">
          Compacting conversation history...
        </div>
      ) : isBusy && feed && feed.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {feed.map((item, i) => (
            <div key={i} className={`font-mono leading-snug truncate ${
              i === feed.length - 1 ? (
                item.type === 'tool' ? 'text-accent-yellow' : 'text-white/90'
              ) : (
                item.type === 'tool' ? 'text-white/40' : 'text-white/30'
              )
            }`}>
              <span className="text-white/20 mr-1 select-none">{item.time}</span>
              {item.type === 'tool' && <span className="text-white/40 mr-0.5">▸</span>}
              {item.type === 'thinking' ? <span className="italic">{item.text}</span> : item.text}
            </div>
          ))}
        </div>
      ) : outputText ? (
        <div
          className={`font-mono leading-relaxed whitespace-pre-wrap ${
            isDone ? 'text-accent-green/80' : 'text-white/70'
          } [&_strong]:font-bold [&_strong]:text-current [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-black/20`}
        >
          <span dangerouslySetInnerHTML={{ __html: renderMiniMarkdown(outputText) }} />
        </div>
      ) : isError ? (
        <div className="font-mono text-accent-orange">
          ! {agent.detail || 'API error - reprompt to retry'}
        </div>
      ) : (
        <div className="font-mono text-white/20">
          {isBusy ? 'Working...' : 'No output yet'}
        </div>
      )}
      </div>
      {/* Pinned elapsed timer — outside scroll area, shifts right when scrollbar visible */}
      {elapsed && (
        <div
          className="absolute bottom-1.5 text-[8px] font-mono text-white/35 pointer-events-none"
          style={{ right: scrollRef.current && scrollRef.current.scrollHeight > scrollRef.current.clientHeight ? 16 : 8 }}
        >{elapsed}</div>
      )}
    </div>
  )
}

