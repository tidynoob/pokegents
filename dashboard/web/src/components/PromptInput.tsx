import { useEffect, useRef, useState, useMemo } from 'react'
import { uploadImage } from '../api'

// Slash commands available in chat mode. NOTE: these are NOT the Claude CLI
// slash commands (`/model`, `/cost`, `/compact`, etc.) — those are parsed by
// the CLI locally before sending to Claude, and chat mode goes through the
// ACP wrapper which forwards text straight to the model. The dashboard
// intercepts these client-side; everything else gets routed via the
// dashboard's API surface (e.g. /clear-context as a server-side handler).
//
// To use full Claude CLI commands, switch the agent to the iTerm2 runtime
// (right-click card → "Switch to iTerm2") — the CLI parses them there.
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: '/cancel', desc: 'Stop the current turn (ACP session/cancel)' },
  { cmd: '/clear', desc: 'Clear the visible transcript (does not erase JSONL)' },
  { cmd: '/exit', desc: 'Shut down this chat session' },
  { cmd: '/model', desc: 'Switch model (e.g. /model claude-opus-4-7)' },
  { cmd: '/effort', desc: 'Set thinking effort: low / medium / high / max' },
  { cmd: '/help', desc: 'Show available chat-mode commands' },
]

// PromptInput is the shared textarea + send affordance used by AgentCard's
// QuickInput and ChatPanel's footer. Handles:
//
//   - Auto-grow (height tracks content, capped by maxHeight prop).
//   - Enter to send, Shift+Enter for newline.
//   - Image paste — detects clipboard image, posts to /api/sessions/{id}/image,
//     embeds `[Image: <path>]` token into the textarea.
//   - Optional inline send button (visible in chat panel; AgentCard hides it
//     because the card grid is too tight).
//
// Routing parity: image upload goes through /api/sessions/{id}/image, which
// works for both runtimes after Phase 5 lands the chat-side handler. Until
// then, image paste from a chat-mode agent still hits the iterm2 endpoint;
// the runtime registry on the backend dispatches based on agent.interface.

export interface PromptInputProps {
  /** Pokegent ID for the upload endpoint. */
  sessionId: string
  /** Sends the prompt. Caller decides which API to call. */
  onSend: (text: string) => void | Promise<void>
  placeholder?: string
  disabled?: boolean
  /** Auto-focus the textarea on mount. */
  autoFocus?: boolean
  /** Show an inline SEND button to the right of the textarea. */
  showSendButton?: boolean
  /** Tailwind classes / inline styles for layout customization. Default styling
   *  matches the GBA-card look in the agent grid. Chat panel passes its own. */
  variant?: 'card' | 'chat'
  maxHeight?: number
  isBusy?: boolean
}

export function PromptInput({
  sessionId,
  onSend,
  placeholder,
  disabled,
  autoFocus,
  showSendButton,
  variant = 'card',
  maxHeight = 120,
  isBusy,
}: PromptInputProps) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)

  // Slash-command autocomplete: active when input starts with `/` and has
  // no spaces yet (i.e. user is still typing the command name).
  const slashPrefix = value.startsWith('/') && !value.includes(' ') ? value.toLowerCase() : null
  const completions = useMemo(() => {
    if (!slashPrefix) return []
    return SLASH_COMMANDS.filter(c => c.cmd.startsWith(slashPrefix))
  }, [slashPrefix])
  const showCompletions = completions.length > 0 && variant === 'chat'

  // Reset selection when completions list changes.
  useEffect(() => { setSelectedIdx(0) }, [completions.length])

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus()
  }, [autoFocus, disabled])

  async function submit() {
    if (!value.trim() || sending || disabled) return
    setSending(true)
    try {
      await onSend(value.trim())
    } finally {
      setValue('')
      setSending(false)
      if (ref.current) ref.current.style.height = 'auto'
    }
  }

  async function handlePaste(e: React.ClipboardEvent) {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue
        const result = await uploadImage(sessionId, blob)
        if (result) {
          setValue(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + `[Image: ${result.path}] `)
        }
        return
      }
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Slash-command autocomplete navigation.
    if (showCompletions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx(i => (i + 1) % completions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx(i => (i - 1 + completions.length) % completions.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const picked = completions[selectedIdx]
        if (picked) {
          setValue(picked.cmd + ' ')
          setSelectedIdx(0)
        }
        return
      }
      if (e.key === 'Escape') {
        // Clear the slash prefix so dropdown closes.
        setValue('')
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function handleInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const t = e.currentTarget
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, maxHeight) + 'px'
  }

  // Card variant: compact GBA-dialog styling, no send button (Enter only).
  if (variant === 'card') {
    return (
      <form
        onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); submit() }}
        onClick={(e) => e.stopPropagation()}
        data-no-drag
        className="mt-1 shrink-0"
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKey}
          onInput={handleInput}
          rows={1}
          placeholder={placeholder ?? 'What will you do?'}
          disabled={disabled}
          className="w-full gba-dialog-dark text-[10px] leading-[14px] font-mono rounded-md px-2 py-0.5 placeholder:text-white/25 outline-none focus:border-[#68a8d8] transition-colors resize-none box-border disabled:opacity-50"
          style={{ minHeight: 22, maxHeight }}
        />
      </form>
    )
  }

  // Chat variant: white GBA-dialog styling (matching card input) with
  // slash-command autocomplete and optional send button.
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit() }}
      className="relative flex items-end gap-1.5 p-2 border-t border-black/30 shrink-0"
    >
      {/* Slash-command autocomplete dropdown — renders above the textarea. */}
      {showCompletions && (
        <div
          className="absolute bottom-full left-2 right-2 mb-1 rounded-md overflow-hidden"
          style={{
            background: 'rgba(15, 25, 40, 0.95)',
            border: '1px solid rgba(255,255,255,0.15)',
            boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {completions.map((c, i) => (
            <button
              key={c.cmd}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                setValue(c.cmd + ' ')
                setSelectedIdx(0)
                ref.current?.focus()
              }}
              onMouseEnter={() => setSelectedIdx(i)}
              className="w-full text-left px-3 py-1.5 flex items-baseline gap-2 transition-colors"
              style={{
                background: i === selectedIdx ? 'rgba(80, 140, 255, 0.2)' : 'transparent',
              }}
            >
              <span className="text-[12px] font-mono text-accent-blue font-semibold shrink-0">{c.cmd}</span>
              <span className="text-[11px] font-sans text-white/50 truncate">{c.desc}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={handlePaste}
        onKeyDown={handleKey}
        onInput={handleInput}
        placeholder={isBusy ? 'Agent is busy. Messages will be added to queue.' : (placeholder ?? 'What will you do?')}
        disabled={disabled}
        className={`flex-1 min-w-0 gba-dialog-dark text-[10px] leading-[14px] font-mono rounded-md px-2.5 py-1 placeholder:text-white/25 outline-none transition-colors resize-none box-border disabled:opacity-50 ${isBusy ? 'border-accent-red/50 focus:border-accent-red/70' : 'focus:border-[#68a8d8]'}`}
        style={{ minHeight: 28, maxHeight }}
      />
      {showSendButton && (
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className={`text-[7px] font-pixel px-3 py-1.5 transition-colors disabled:opacity-50 ${isBusy ? 'gba-button-red' : 'gba-button'}`}
        >{isBusy ? 'QUEUE' : 'SEND'}</button>
      )}
    </form>
  )
}
