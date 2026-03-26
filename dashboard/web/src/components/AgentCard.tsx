import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AgentState } from '../types'
import { StatusBadge } from './StatusBadge'
import { CreatureIcon, hashString } from './CreatureIcon'
import { renameAgent, focusAgent, checkAgentMessages, spawnClone, shutdownAgent, setSprite, sendPrompt } from '../api'
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

function HealthBar({ tokens, window: ctxWindow, muted }: { tokens: number; window: number; muted?: boolean }) {
  if (!ctxWindow && !tokens) {
    return (
      <div className="flex items-center gap-1.5 mt-1">
        <span className="text-[8px] font-bold text-zinc-500 shrink-0">CTX</span>
        <div className="flex-1 h-[6px] border border-zinc-700 rounded-sm bg-zinc-900" />
        <span className="text-[8px] text-zinc-700 shrink-0">—</span>
      </div>
    )
  }

  const usage = tokens / (ctxWindow || 1000000)
  const hp = Math.max(0, Math.min(100, (1 - usage) * 100))

  let color: string
  if (muted) {
    color = 'rgba(255, 255, 255, 0.1)'
    if (hp < 20) color = 'rgba(255, 255, 255, 0.04)'
    else if (hp < 50) color = 'rgba(255, 255, 255, 0.07)'
  } else {
    color = '#4ade80'
    if (hp < 20) color = '#f87171'
    else if (hp < 50) color = '#facc15'
  }

  const usedK = Math.round(tokens / 1000)
  const totalK = Math.round(ctxWindow / 1000)

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span className="text-[8px] font-bold text-zinc-500 shrink-0">CTX</span>
      <div className="flex-1 h-[6px] border border-zinc-700 rounded-sm bg-zinc-900 overflow-hidden">
        <div
          className="h-full transition-all duration-1000"
          style={{ width: `${hp}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[8px] text-zinc-600 shrink-0 tabular-nums">{usedK}k/{totalK}k</span>
    </div>
  )
}

function QuickInput({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!value.trim() || sending) return
    setSending(true)
    await sendPrompt(sessionId, value.trim())
    setValue('')
    setSending(false)
  }

  return (
    <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="mt-1.5 shrink-0">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Send command..."
        className="w-full bg-black/30 border border-zinc-800 rounded-md px-2.5 py-1.5 text-[10px] font-mono text-zinc-300 placeholder:text-zinc-700 outline-none focus:border-zinc-600 transition-colors"
      />
    </form>
  )
}

type LayoutMode = 'max' | 'standard' | 'standard-short' | 'compact' | 'compact-minimal'

interface AgentCardProps {
  agent: AgentState
  onClick: () => void
  mode: LayoutMode
  connectedAgents?: { session_id: string; emoji: string; display_name: string }[]
  spriteOverride?: string
  isReading?: boolean
  hideSprite?: boolean
  mutedCtx?: boolean
  cardRef?: (el: HTMLDivElement | null) => void
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

export function AgentCard({ agent, onClick, mode, connectedAgents, spriteOverride, isReading, hideSprite, mutedCtx, cardRef }: AgentCardProps) {
  const compact = mode === 'compact' || mode === 'compact-minimal'
  const showPrompt = mode === 'max' || mode === 'standard'
  const showInput = mode !== 'compact-minimal'
  const outputH = (mode === 'standard-short' || compact) ? 'h-[52px]' : 'h-[90px]'
  const title = agent.display_name || agent.profile_name || 'Agent'
  const showDetail = agent.detail && !HIDE_DETAILS.has(agent.detail)
  const [r, g, b] = agent.color
  const isBusy = agent.state === 'busy'
  const isDone = agent.state === 'done'
  const isIdle = agent.state === 'idle'
  const isError = agent.state === 'error'
  // After 30min of "done", treat as idle for display purposes
  const ageSeconds = agent.last_updated ? (Date.now() - new Date(agent.last_updated).getTime()) / 1000 : 0
  const effectiveIdle = isIdle || (isDone && ageSeconds > 1800)
  const outputText = isBusy ? agent.last_trace : agent.last_summary

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(title)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [showSpritePicker, setShowSpritePicker] = useState(false)
  const [flashDismissed, setFlashDismissed] = useState(false)
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
  const textSize = compact ? 'text-[10px]' : 'text-[11px]'
  const pad = compact ? 'px-2 py-1.5' : 'p-4'

  return (
    <>
      <div
        ref={cardRef ? (el) => cardRef(el) : undefined}
        onContextMenu={handleContextMenu}
        className={`text-left rounded-xl ${pad} border cursor-default overflow-hidden flex flex-col min-h-0 transition-all duration-150 relative group`}
        style={{
          background: `rgba(${r}, ${g}, ${b}, 0.06)`,
          borderColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = `rgba(${r}, ${g}, ${b}, 0.14)`
          e.currentTarget.style.borderColor = `rgba(${r}, ${g}, ${b}, 0.3)`
          if (isDone && !flashDismissed) setFlashDismissed(true)
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = `rgba(${r}, ${g}, ${b}, 0.06)`
          e.currentTarget.style.borderColor = `rgba(${r}, ${g}, ${b}, 0.15)`
        }}
      >
        {/* Done flash — pulses for 1 minute after completion, dismissed on hover */}
        {isDone && !effectiveIdle && ageSeconds < 60 && !flashDismissed && (
          <div
            className="card-done-flash absolute inset-0 rounded-xl pointer-events-none group-hover:hidden"
            style={{ background: `rgba(${r}, ${g}, ${b}, 0.08)` }}
          />
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
            {!compact && <div className="absolute inset-0 bg-surface-2 rounded-lg" />}
            {/* Animated sprite + bubbles */}
            <SpriteAnimWrapper state={isDone && !effectiveIdle && ageSeconds < 60 && !flashDismissed ? 'celebrating' : agent.state} compact={compact}>
              <div style={{ opacity: hideSprite ? 0 : 1, transition: 'opacity 0.15s' }}>
                <CreatureIcon sessionId={agent.session_id} size={iconSize} noGlow={compact} doneFlash={false} spriteOverride={spriteOverride} noBg />
              </div>
              {!compact && <BusyBubble isBusy={isBusy} />}
              {!compact && <DoneBubble isDone={isDone} />}
              <ReadingIndicator isReading={!!isReading} />
            </SpriteAnimWrapper>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
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
                    className={`${compact ? 'text-[11px]' : 'text-sm'} font-medium text-zinc-100 bg-transparent border-b border-zinc-500 outline-none w-full`}
                  />
                ) : (
                  <h3
                    className={`${compact ? 'text-[11px]' : 'text-sm'} font-medium text-zinc-100 truncate cursor-pointer hover:text-white`}
                    onClick={(e) => { e.stopPropagation(); setEditValue(title); setEditing(true) }}
                  >
                    {title}
                  </h3>
                )}
                <HealthBar tokens={agent.context_tokens} window={agent.context_window} muted={mutedCtx} />
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <StatusBadge status={agent.state} lastUpdated={agent.last_updated} busySince={agent.busy_since} />
              </div>
            </div>
          </div>
        </div>

        {/* Last prompt — shown in max and standard modes */}
        {showPrompt && agent.user_prompt && (
          <div
            className="rounded-md px-3 py-1.5 mb-1 shrink-0 overflow-hidden"
            style={{ background: 'rgba(0, 0, 0, 0.35)' }}
          >
            <div className="text-[9px] font-mono text-zinc-500 italic line-clamp-2 leading-none">
              <span className="text-[8px] font-medium font-sans not-italic text-blue-400/70 bg-blue-400/10 px-1 py-0.5 rounded mr-1.5 inline-block align-middle">prompt</span>
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
          effectiveIdle={effectiveIdle}
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

function ActivityBox({ agent, isBusy, isDone, isError, effectiveIdle, outputText, compact, outputH, textSize }: {
  agent: AgentState; isBusy: boolean; isDone: boolean; isError: boolean; effectiveIdle: boolean;
  outputText: string; compact: boolean; outputH: string; textSize: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const feed = agent.activity_feed

  // Auto-scroll to bottom when feed updates
  useEffect(() => {
    if (scrollRef.current && isBusy) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [feed?.length, isBusy])

  return (
    <div
      ref={scrollRef}
      className={`rounded-md ${compact ? 'px-2 py-1.5' : 'px-3 py-2'} ${outputH} overflow-y-auto overflow-x-hidden cursor-pointer hover:brightness-110`}
      style={{ background: 'rgba(0, 0, 0, 0.35)' }}
      onClick={(e) => { e.stopPropagation(); focusAgent(agent.session_id) }}
    >
      {isBusy && feed && feed.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {feed.map((item, i) => (
            <div key={i} className={`text-[10px] font-mono leading-snug truncate ${
              i === feed.length - 1 ? (
                item.type === 'tool' ? 'text-amber-300/80' : 'text-zinc-300'
              ) : (
                item.type === 'tool' ? 'text-zinc-600' : 'text-zinc-500'
              )
            }`}>
              <span className="text-zinc-700 mr-1 select-none">{item.time}</span>
              {item.type === 'tool' && <span className="text-zinc-600 mr-0.5">▸</span>}
              {item.type === 'thinking' ? <span className="italic">{item.text}</span> : item.text}
            </div>
          ))}
        </div>
      ) : outputText ? (
        <div
          className={`${textSize} font-mono leading-relaxed whitespace-pre-wrap overflow-hidden ${
            effectiveIdle ? 'text-zinc-500' : isDone ? 'text-emerald-300/70' : 'text-zinc-400'
          } [&_strong]:font-bold [&_strong]:text-current [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-white/5`}
        >
          <span dangerouslySetInnerHTML={{ __html: renderMiniMarkdown(outputText) }} />
        </div>
      ) : isError ? (
        <div className="text-[10px] font-mono text-orange-400">
          ⚠ {agent.detail || 'API error — reprompt to retry'}
        </div>
      ) : (
        <div className="text-[10px] font-mono text-zinc-700">
          {isBusy ? 'Working...' : 'No output yet'}
        </div>
      )}
    </div>
  )
}

function ContextMenu({ x, y, agent, onClose, onRename, onChangeSprite }: {
  x: number
  y: number
  agent: AgentState
  onClose: () => void
  onRename: () => void
  onChangeSprite: () => void
}) {
  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', keyHandler)
    return () => document.removeEventListener('keydown', keyHandler)
  }, [onClose])

  // Clamp menu position to viewport
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 220),
    zIndex: 10000,
  }

  const items = [
    { label: 'Go to terminal', icon: '⌨', action: () => { focusAgent(agent.session_id); onClose() } },
    { label: 'Check messages', icon: '💬', action: () => { checkAgentMessages(agent.session_id); onClose() } },
    { label: 'Rename', icon: '✏️', action: onRename },
    { label: 'Change pokemon', icon: '🔄', action: onChangeSprite },
    { label: 'Spawn clone', icon: '🧬', action: () => { spawnClone(agent.session_id); onClose() } },
  ]

  return (
    <>
      {/* Invisible backdrop to catch clicks outside */}
      <div
        className="fixed inset-0"
        style={{ zIndex: 9999 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div style={menuStyle}>
        <div className="bg-surface-1 border border-zinc-700 rounded-lg shadow-2xl py-1 min-w-[180px]">
        {items.map((item) => (
          <button
            key={item.label}
            onClick={(e) => { e.stopPropagation(); item.action() }}
            className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 flex items-center gap-2 transition-colors"
          >
            <span className="w-4 text-center">{item.icon}</span>
            {item.label}
          </button>
        ))}
        <div className="border-t border-zinc-700 my-1" />
        <button
          onClick={(e) => { e.stopPropagation(); shutdownAgent(agent.session_id); onClose() }}
          className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/30 hover:text-red-300 flex items-center gap-2 transition-colors"
        >
          <span className="w-4 text-center">⏻</span>
          Shut down
        </button>
        </div>
      </div>
    </>
  )
}
