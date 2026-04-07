import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AgentState } from '../types'
import { CreatureIcon, hashString } from './CreatureIcon'
import { renameAgent, focusAgent, checkAgentMessages, spawnClone, shutdownAgent, setSprite, sendPrompt, uploadImage, assignRole, assignProject, ProjectInfo, RoleInfo } from '../api'
import { SpritePicker } from './SpritePicker'
import { POKEMON_SPRITES } from './sprites'
import { BusyBubble, DoneBubble, ReadingIndicator } from './MessageAnimations'
import { useSpriteAnimation } from './spriteAnimations'

function renderMiniMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

function ProfilePill({ name, color }: { name: string; color?: [number, number, number] }) {
  const [r, g, b] = color || [100, 100, 100]
  return (
    <span
      className="text-[6px] font-pixel text-white rounded-sm px-1.5 py-px pixel-shadow shrink-0 uppercase"
      style={{ background: `rgba(${r}, ${g}, ${b}, 0.6)`, border: `1px solid rgba(${r}, ${g}, ${b}, 0.8)` }}
    >{name}</span>
  )
}

function RolePill({ name }: { name: string }) {
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

function TaskGroupPill({ name }: { name: string }) {
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

function HealthBar({ tokens, window: ctxWindow }: { tokens: number; window: number }) {
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

function QuickInput({ sessionId, onFocus, onBlur }: { sessionId: string; onFocus?: () => void; onBlur?: () => void }) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!value.trim() || sending) return
    setSending(true)
    await sendPrompt(sessionId, value.trim())
    setValue('')
    setSending(false)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue
        const result = await uploadImage(sessionId, blob)
        if (result) {
          setValue(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + `[Image: ${result.path}]` + ' ')
        }
        return
      }
    }
  }

  return (
    <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} data-no-drag className="mt-1.5 shrink-0">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={handlePaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit(e)
          }
        }}
        onInput={(e) => {
          const t = e.currentTarget
          t.style.height = 'auto'
          t.style.height = Math.min(t.scrollHeight, 80) + 'px'
        }}
        rows={1}
        placeholder="What will you do?"
        className="w-full gba-dialog text-[10px] leading-[14px] font-mono rounded-md px-2.5 py-1 text-gba-dialog-border placeholder:text-gba-dialog-border/30 outline-none focus:border-[#68a8d8] transition-colors resize-none box-border"
        style={{ minHeight: 28 }}
      />
    </form>
  )
}

type LayoutMode = 'standard' | 'compact' | 'compact-minimal'

interface AgentCardProps {
  agent: AgentState
  onClick: () => void
  mode: LayoutMode
  connectedAgents?: { session_id: string; emoji: string; display_name: string }[]
  spriteOverride?: string
  spriteSessionId?: string  // ccd_session_id for consistent sprite hashing (matches pokegent.sh)
  isReading?: boolean
  hideSprite?: boolean
  onCollapse?: () => void
  cardRef?: (el: HTMLDivElement | null) => void
  projects?: ProjectInfo[]
  roles?: RoleInfo[]
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

export function AgentCard({ agent, onClick, mode, connectedAgents, spriteOverride, spriteSessionId, isReading, hideSprite, onCollapse, cardRef, projects, roles }: AgentCardProps) {
  const compact = mode === 'compact' || mode === 'compact-minimal'
  const showPrompt = mode === 'standard'
  const showInput = mode !== 'compact-minimal'
  const outputH = 'flex-1 min-h-[40px]'
  const title = agent.display_name || agent.profile_name || 'Agent'
  const showDetail = agent.detail && !HIDE_DETAILS.has(agent.detail)
  const [r, g, b] = agent.color
  const isBusy = agent.state === 'busy'
  const isDone = agent.state === 'done'
  const isIdle = agent.state === 'idle'
  const isError = agent.state === 'error'
  const ageSeconds = agent.last_updated ? (Date.now() - new Date(agent.last_updated).getTime()) / 1000 : 0
  const isCompacting = agent.detail === 'compacting'
  const outputText = isCompacting ? null : (isBusy ? agent.last_trace : agent.last_summary)

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(title)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [showSpritePicker, setShowSpritePicker] = useState(false)
  const [flashDismissed, setFlashDismissed] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // Reset flash dismissed when agent starts a new turn
  useEffect(() => {
    if (isBusy) setFlashDismissed(false)
  }, [isBusy])

  const renamePending = useRef(false)
  const handleRename = async () => {
    if (renamePending.current) return
    const newName = editValue.trim()
    setEditing(false)
    if (newName && newName !== title) {
      renamePending.current = true
      await renameAgent(agent.session_id, newName)
      renamePending.current = false
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
    setMenuOpen(true)
  }

  const iconSize = compact ? 20 : 32
  const textSize = 'text-[10px]'
  const pad = compact ? 'px-2 py-1.5' : 'p-4'

  return (
    <>
      <div
        ref={cardRef ? (el) => cardRef(el) : undefined}
        onContextMenu={handleContextMenu}
        className={`text-left ${pad} cursor-default overflow-hidden flex flex-col h-full transition-all duration-300 relative group ${
          isBusy ? 'gba-card-selected' : 'gba-card'
        } ${agent.ephemeral ? 'opacity-80' : ''}`}
        style={agent.ephemeral ? { borderStyle: 'dashed' } : undefined}
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

        {/* Header: icon + name + status */}
        <div className={`flex items-center ${compact ? 'gap-1.5 mb-1' : 'gap-3 mb-2'} shrink-0`}>
          {/* Click sprite → change sprite */}
          <div
            onClick={(e) => { e.stopPropagation(); setShowSpritePicker(true) }}
            className="cursor-pointer hover:brightness-125 relative"
            style={{ width: iconSize, height: iconSize }}
          >
            {/* Static background box */}
            {!compact && <div className="absolute inset-0 bg-black/20 rounded-lg" />}
            {/* Animated sprite + bubbles */}
            <SpriteAnimWrapper state={isDone && !isIdle && ageSeconds < 60 && !flashDismissed ? 'celebrating' : agent.state} compact={compact}>
              <div style={{ opacity: hideSprite ? 0 : 1, transition: 'opacity 0.15s' }}>
                <CreatureIcon sessionId={spriteSessionId || agent.session_id} size={iconSize} noGlow={compact} doneFlash={false} spriteOverride={spriteOverride} noBg />
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
                {editing ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename()
                      if (e.key === 'Escape') setEditing(false)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className={`${compact ? 'text-[7px]' : 'text-[8px]'} font-pixel text-white bg-transparent border-b border-white/50 outline-none w-full pixel-shadow`}
                  />
                ) : (
                  <h3
                    className={`${compact ? 'text-[7px]' : 'text-[8px]'} font-pixel text-white truncate cursor-pointer hover:text-accent-yellow pixel-shadow`}
                    onClick={(e) => { e.stopPropagation(); setEditValue(title); setEditing(true) }}
                  >
                    {title}
                  </h3>
                )}
                <HealthBar tokens={agent.context_tokens} window={agent.context_window} />
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                {!compact && (
                  <>
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
            className="rounded-md px-3 py-1.5 mb-1 shrink-0 overflow-hidden"
            style={{ background: 'rgba(0, 0, 0, 0.40)', boxShadow: 'inset 1px 1px 0 rgba(0,0,0,0.4)' }}
          >
            <div className="text-[10px] font-mono text-white/50 italic line-clamp-2 leading-snug">
              <span className="text-[7px] font-pixel not-italic text-accent-blue bg-accent-blue/20 px-1 py-0.5 rounded mr-1.5 inline-block align-middle pixel-shadow">CMD</span>
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
          <QuickInput sessionId={agent.session_id} />
        )}
      </div>

      {/* Right-click context menu */}
      {menuOpen && createPortal(
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          agent={agent}
          onClose={() => setMenuOpen(false)}
          onRename={() => { setMenuOpen(false); setEditValue(title); setEditing(true) }}
          onChangeSprite={() => { setMenuOpen(false); setShowSpritePicker(true) }}
          onCollapse={onCollapse}
          projects={projects}
          roles={roles}
          onAssignStatus={(msg) => { setToast(msg); setTimeout(() => setToast(null), 2500) }}
        />,
        document.body
      )}

      {/* Sprite picker */}
      {showSpritePicker && createPortal(
        <SpritePicker
          currentSprite={spriteOverride || POKEMON_SPRITES[hashString(agent.session_id) % POKEMON_SPRITES.length]}
          onSelect={async (sprite) => { await setSprite(agent.session_id, sprite); window.location.reload() }}
          onClose={() => setShowSpritePicker(false)}
        />,
        document.body
      )}
    </>
  )
}

function formatElapsed(lastUpdated?: string): string {
  if (!lastUpdated) return ''
  const secs = Math.max(0, (Date.now() - new Date(lastUpdated).getTime()) / 1000)
  if (secs < 60) return `${Math.floor(secs)}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`
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
        style={{ background: 'rgba(0, 0, 0, 0.45)', boxShadow: 'inset 1px 1px 0 rgba(0,0,0,0.4)' }}
        onClick={(e) => { e.stopPropagation(); focusAgent(agent.session_id) }}
      >
      {isCompacting ? (
        <div className="text-[10px] font-mono text-accent-yellow/80 animate-pulse">
          Compacting conversation history...
        </div>
      ) : isBusy && feed && feed.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {feed.map((item, i) => (
            <div key={i} className={`text-[10px] font-mono leading-snug truncate ${
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
          className={`text-[10px] font-mono leading-relaxed whitespace-pre-wrap ${
            isDone ? 'text-accent-green/80' : 'text-white/70'
          } [&_strong]:font-bold [&_strong]:text-current [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-black/20`}
        >
          <span dangerouslySetInnerHTML={{ __html: renderMiniMarkdown(outputText) }} />
        </div>
      ) : isError ? (
        <div className="text-[10px] font-mono text-accent-orange">
          ! {agent.detail || 'API error - reprompt to retry'}
        </div>
      ) : (
        <div className="text-[10px] font-mono text-white/20">
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

function ContextMenu({ x, y, agent, onClose, onRename, onChangeSprite, onCollapse, projects, roles, onAssignStatus }: {
  x: number
  y: number
  agent: AgentState
  onClose: () => void
  onRename: () => void
  onChangeSprite: () => void
  onCollapse?: () => void
  onAssignStatus?: (msg: string) => void
  projects?: ProjectInfo[]
  roles?: RoleInfo[]
}) {
  const [submenu, setSubmenu] = useState<'role' | 'project' | null>(null)

  const showStatus = (res: { status: string }, label: string) => {
    if (!onAssignStatus) return
    if (res.status === 'relaunching') onAssignStatus(`Relaunching as ${label}...`)
    else if (res.status === 'queued') onAssignStatus(`Queued — ${label} on idle`)
    else if (res.status === 'updated') onAssignStatus(`Set ${label}`)
  }

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (submenu) setSubmenu(null); else onClose() }
    }
    document.addEventListener('keydown', keyHandler)
    return () => document.removeEventListener('keydown', keyHandler)
  }, [onClose, submenu])

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 300),
    zIndex: 10000,
  }

  const items = [
    { label: 'Go to terminal', icon: '⌨', action: () => { focusAgent(agent.session_id); onClose() } },
    { label: 'Check messages', icon: '💬', action: () => { checkAgentMessages(agent.session_id); onClose() } },
    { label: 'Rename', icon: '✏️', action: onRename },
    { label: 'Change pokemon', icon: '🔄', action: onChangeSprite },
    { label: 'Spawn clone', icon: '🧬', action: () => { spawnClone(agent.session_id); onClose() } },
    ...(onCollapse ? [{ label: 'Collapse', icon: '📌', action: () => { onCollapse(); onClose() } }] : []),
  ]

  return (
    <>
      <div
        className="fixed inset-0"
        style={{ zIndex: 9999 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div style={menuStyle}>
        <div className="gba-panel py-1 min-w-[190px]">
        {items.map((item) => (
          <button
            key={item.label}
            onClick={(e) => { e.stopPropagation(); item.action() }}
            className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-white/90 hover:bg-white/10 hover:text-white flex items-center gap-2 transition-colors pixel-shadow"
          >
            <span className="w-4 text-center">{item.icon}</span>
            {item.label}
          </button>
        ))}

        {/* Role/Project assignment */}
        {(roles && roles.length > 0 || projects && projects.length > 0) && (
          <>
            <div className="border-t border-white/10 my-1" />
            {roles && roles.length > 0 && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setSubmenu(submenu === 'role' ? null : 'role') }}
                  className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-white/90 hover:bg-white/10 hover:text-white flex items-center gap-2 transition-colors pixel-shadow"
                >
                  <span className="w-4 text-center">🎭</span>
                  {agent.role ? `Role: ${agent.role}` : 'Assign role'}
                  <span className="ml-auto text-white/30">▸</span>
                </button>
                {submenu === 'role' && (
                  <div className="absolute left-full top-0 ml-1 gba-panel py-1 min-w-[140px]">
                    {agent.role && (
                      <button
                        onClick={async (e) => { e.stopPropagation(); const res = await assignRole(agent.session_id, ''); showStatus(res, 'no role'); onClose() }}
                        className="w-full text-left px-3 py-1.5 text-[7px] font-pixel text-white/40 hover:bg-white/10 transition-colors pixel-shadow italic"
                      >
                        None
                      </button>
                    )}
                    {roles.map(r => (
                      <button
                        key={r.name}
                        onClick={async (e) => { e.stopPropagation(); const res = await assignRole(agent.session_id, r.name); showStatus(res, r.title); onClose() }}
                        className={`w-full text-left px-3 py-1.5 text-[7px] font-pixel hover:bg-white/10 transition-colors pixel-shadow flex items-center gap-1.5 ${agent.role === r.name ? 'text-accent-yellow' : 'text-white/90'}`}
                      >
                        <span>{r.emoji}</span>
                        <span>{r.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {projects && projects.length > 0 && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setSubmenu(submenu === 'project' ? null : 'project') }}
                  className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-white/90 hover:bg-white/10 hover:text-white flex items-center gap-2 transition-colors pixel-shadow"
                >
                  <span className="w-4 text-center">📁</span>
                  {agent.project ? `Project: ${agent.project}` : 'Assign project'}
                  <span className="ml-auto text-white/30">▸</span>
                </button>
                {submenu === 'project' && (
                  <div className="absolute left-full top-0 ml-1 gba-panel py-1 min-w-[140px]">
                    {agent.project && (
                      <button
                        onClick={async (e) => { e.stopPropagation(); const res = await assignProject(agent.session_id, ''); showStatus(res, 'no project'); onClose() }}
                        className="w-full text-left px-3 py-1.5 text-[7px] font-pixel text-white/40 hover:bg-white/10 transition-colors pixel-shadow italic"
                      >
                        None
                      </button>
                    )}
                    {projects.map(p => (
                      <button
                        key={p.name}
                        onClick={async (e) => { e.stopPropagation(); const res = await assignProject(agent.session_id, p.name); showStatus(res, p.title); onClose() }}
                        className={`w-full text-left px-3 py-1.5 text-[7px] font-pixel hover:bg-white/10 transition-colors pixel-shadow flex items-center gap-1.5 ${agent.project === p.name ? 'text-accent-yellow' : 'text-white/90'}`}
                      >
                        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: `rgb(${p.color[0]},${p.color[1]},${p.color[2]})` }} />
                        <span>{p.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="border-t border-white/10 my-1" />
        <button
          onClick={(e) => { e.stopPropagation(); shutdownAgent(agent.session_id); onClose() }}
          className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-accent-red hover:bg-white/10 flex items-center gap-2 transition-colors pixel-shadow"
        >
          <span className="w-4 text-center">⏻</span>
          Release
        </button>
        </div>
      </div>
    </>
  )
}
