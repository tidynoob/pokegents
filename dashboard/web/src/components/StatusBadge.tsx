import { useEffect, useState } from 'react'

const STATUS_CONFIG: Record<string, { label: string; dotColor: string; textColor: string; timeColor: string; pulse?: boolean }> = {
  idle:        { label: 'Idle',        dotColor: 'bg-zinc-500',    textColor: 'text-zinc-400',    timeColor: 'text-zinc-500' },
  busy:        { label: 'Busy',        dotColor: 'bg-amber-400',   textColor: 'text-amber-400',   timeColor: 'text-amber-400/60', pulse: true },
  done:        { label: 'Done',        dotColor: 'bg-emerald-400', textColor: 'text-emerald-400', timeColor: 'text-emerald-400/60' },
  needs_input: { label: 'Needs input', dotColor: 'bg-red-400',     textColor: 'text-red-400',     timeColor: 'text-red-400/60', pulse: true },
  error:       { label: 'Error',       dotColor: 'bg-orange-400',  textColor: 'text-orange-400',  timeColor: 'text-orange-400/60', pulse: true },
  starting:    { label: 'Starting',   dotColor: 'bg-blue-400',    textColor: 'text-blue-400',    timeColor: 'text-blue-400/60', pulse: true },
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function getTimeLabel(status: string, seconds: number): string {
  if (status === 'busy') return formatDuration(seconds)
  if (status === 'done') return `${formatDuration(seconds)} ago`
  if (status === 'idle') return formatDuration(seconds)
  if (status === 'needs_input') return formatDuration(seconds)
  return formatDuration(seconds)
}

interface StatusBadgeProps {
  status: string
  lastUpdated?: string
  busySince?: string
}

export function StatusBadge({ status, lastUpdated, busySince }: StatusBadgeProps) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  // For busy state, count from when the prompt was issued (busySince),
  // not from the last hook event (lastUpdated)
  const timeRef = (status === 'busy' && busySince) ? busySince : lastUpdated
  const seconds = timeRef
    ? Math.max(0, (now - new Date(timeRef).getTime()) / 1000)
    : 0

  // After 30 minutes of "done", show as idle
  const effectiveStatus = (status === 'done' && seconds > 1800) ? 'idle' : status
  const config = STATUS_CONFIG[effectiveStatus] || STATUS_CONFIG.idle
  const timeLabel = timeRef ? getTimeLabel(effectiveStatus, seconds) : ''

  return (
    <div className="flex flex-col items-end gap-0.5 shrink-0">
      <span className={`inline-flex items-center gap-1 text-[10px] ${config.textColor}`}>
        <span className={`w-1 h-1 rounded-full ${config.dotColor} ${config.pulse ? 'animate-pulse-soft' : ''}`} />
        {config.label}
      </span>
      {timeLabel && (
        <span className={`text-[8px] ${config.timeColor}`}>
          {timeLabel}
        </span>
      )}
    </div>
  )
}
