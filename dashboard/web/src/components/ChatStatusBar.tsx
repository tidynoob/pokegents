import { useEffect, useState } from 'react'
import { AgentState } from '../types'
import { BgShell, BgShellStatus, truncateCommand } from '../utils/bgShells'
import { formatElapsed } from '../utils/elapsed'

// ChatStatusBar renders below the ChatPanel's input box. Two zones:
//
//   Top line: profile / permissions / model / effort — mirrors what the
//             Claude CLI shows below its prompt (🏠 Personal · bypass on).
//   Optional second zone: a list of currently-running background shells
//             (`Bash(run_in_background=true)`) tracked through their
//             BashOutput / KillShell follow-ups. Rows for completed/
//             killed/failed shells linger ~5s before clearing.
//
// Visual: tight one-liner header + per-shell rows with status dot, command
// preview, and live elapsed timer. Click a shell to expand its last
// captured output.

interface ChatStatusBarProps {
  agent: AgentState
  shells: BgShell[]
  children?: React.ReactNode
}

const STATUS_DOT: Record<BgShellStatus, string> = {
  running: 'bg-accent-yellow animate-pulse-soft',
  completed: 'bg-accent-green',
  failed: 'bg-accent-red',
  killed: 'bg-white/40',
}

const STATUS_LABEL: Record<BgShellStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  killed: 'killed',
}

export function ChatStatusBar({ agent, shells, children }: ChatStatusBarProps) {
  // Profile label: prefer an explicit role+project combination, fall back
  // to profile_name. Mirrors the resolution logic in pokegent.sh launch.
  const profileLabel = (() => {
    if (agent.role && agent.project) return `${agent.role} · ${agent.project}`
    if (agent.project) return agent.project
    return agent.profile_name || ''
  })()
  // Project / profile color tints the indicator dot to match the
  // AgentCard's profile pill visual language.
  const [r, g, b] = agent.project_color || agent.color || [100, 100, 100]
  const dotStyle = { background: `rgba(${r},${g},${b},0.85)` }

  // Chat-mode is locked to bypass-permissions today (claude-agent-acp
  // hardcodes --allow-dangerously-skip-permissions in its SDK invocation).
  // When we add a permission-mode toggle we'll read it from agent state.
  const permissionLabel = agent.interface === 'chat' ? 'bypass permissions on' : 'default permissions'

  return (
    <div className="shrink-0 px-3 py-1.5 border-t border-black/30 text-[10px] font-mono text-white/60 select-none">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full" style={dotStyle} />
          <span className="text-white/80">{profileLabel || 'no profile'}</span>
        </span>
        <span className="text-accent-red/70" title="Chat mode runs through ACP which bypasses Claude Code's permission prompts; use right-click → Switch to iTerm2 for full permission flow.">
          ▸▸ {permissionLabel}
        </span>
        {agent.model && (
          <span className="text-white/50">{agent.model}</span>
        )}
        {agent.effort && (
          <span className="text-white/50">effort: {agent.effort}</span>
        )}
        {children && <span className="ml-auto">{children}</span>}
      </div>

      {shells.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {shells.map(s => <BgShellRow key={s.taskId} shell={s} />)}
        </div>
      )}
    </div>
  )
}

function BgShellRow({ shell }: { shell: BgShell }) {
  // Tick the elapsed timer once per second while the shell is live.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (shell.status !== 'running') return
    const iv = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(iv)
  }, [shell.status])

  const [open, setOpen] = useState(false)
  const elapsed = shell.status === 'running'
    ? formatElapsed(shell.startedAt)
    : (shell.endedAt && shell.startedAt
        ? Math.max(0, Math.floor((shell.endedAt - shell.startedAt) / 1000)) + 's'
        : '')

  return (
    <div className="rounded-sm">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 text-left hover:bg-white/5 px-1.5 py-0.5 rounded-sm transition-colors"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[shell.status]}`} />
        <span className="text-white/80 truncate flex-1 font-mono text-[10px]">
          {truncateCommand(shell.command, 70)}
        </span>
        <span className="text-white/35 text-[9px] shrink-0 tabular-nums">
          {STATUS_LABEL[shell.status]} {elapsed}
        </span>
        {typeof shell.exitCode === 'number' && (
          <span className="text-white/30 text-[9px] shrink-0">exit {shell.exitCode}</span>
        )}
      </button>
      {open && shell.lastOutput && (
        <pre className="text-[9px] font-mono text-white/45 bg-black/30 rounded mx-1.5 my-1 px-2 py-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">
          {shell.lastOutput}
        </pre>
      )}
    </div>
  )
}
