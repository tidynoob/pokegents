import { useEffect, useRef } from 'react'
import { DashboardSettings } from '../hooks/useSettings'

interface SettingsPanelProps {
  settings: DashboardSettings
  defaults: DashboardSettings
  onChange: (update: Partial<DashboardSettings>) => void
  onReset: () => void
  onClose: () => void
  onTestMessaging?: () => void
  onGridDragging?: (dragging: boolean) => void
}

function Slider({ label, value, min, max, step, unit, onChange, onDragStart, onDragEnd }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string
  onChange: (v: number) => void
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-[7px] font-pixel text-white/70 pixel-shadow w-24 shrink-0">{label}</label>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        onPointerDown={() => onDragStart?.()}
        onPointerUp={() => onDragEnd?.()}
        className="flex-1 h-1.5 accent-accent-blue cursor-pointer"
      />
      <span className="text-[10px] font-mono text-white/50 w-12 text-right">{value}{unit || ''}</span>
    </div>
  )
}

function Toggle({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-[7px] font-pixel text-white/70 pixel-shadow">{label}</label>
      <button
        onClick={() => onChange(!checked)}
        className={`w-8 h-4 rounded-full transition-colors relative ${checked ? 'bg-accent-green' : 'bg-white/20'}`}
        style={{ boxShadow: 'inset 1px 1px 0 rgba(0,0,0,0.3)' }}
      >
        <div
          className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
          style={{
            transform: checked ? 'translateX(16px)' : 'translateX(2px)',
            boxShadow: '1px 1px 0 rgba(0,0,0,0.2)',
          }}
        />
      </button>
    </div>
  )
}

function OptionGroup<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void
}) {
  return (
    <div>
      <label className="text-[7px] font-pixel text-white/70 pixel-shadow block mb-1.5">{label}</label>
      <div className="flex gap-1">
        {options.map(opt => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`text-[7px] font-pixel px-2 py-1 rounded transition-colors ${
              value === opt.value
                ? 'bg-accent-blue text-white'
                : 'bg-white/10 text-white/50 hover:bg-white/20'
            }`}
            style={{
              boxShadow: value === opt.value
                ? 'inset 1px 1px 0 rgba(255,255,255,0.2), inset -1px -1px 0 rgba(0,0,0,0.2)'
                : 'none',
              textShadow: '1px 1px 0 rgba(0,0,0,0.4)',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function SettingsPanel({ settings, defaults, onChange, onReset, onClose, onTestMessaging, onGridDragging }: SettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={panelRef} className="absolute top-full right-0 mt-1 z-50 w-[300px]">
      <div className="gba-panel p-4 space-y-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[8px] font-pixel text-white pixel-shadow">SETTINGS</h3>
          <button
            onClick={onReset}
            className="text-[6px] font-pixel text-white/30 hover:text-white/60 pixel-shadow transition-colors"
          >
            RESET
          </button>
        </div>

        {/* Theme */}
        <OptionGroup
          label="THEME"
          value={settings.theme}
          options={[
            { value: 'fire-red', label: 'FIRE RED' },
            { value: 'classic', label: 'CLASSIC' },
          ]}
          onChange={v => onChange({ theme: v })}
        />

        {/* Output Font Size */}
        <Slider
          label="OUTPUT FONT"
          value={settings.outputFontSize}
          min={8} max={18} step={1}
          unit="px"
          onChange={v => onChange({ outputFontSize: v })}
        />

        {/* (Grid columns/rows are now derived from CARDS PER ROW / COL below.) */}

        {/* Card Gap */}
        <Slider
          label="CARD GAP"
          value={settings.cardGap}
          min={0} max={24} step={1}
          unit="px"
          onChange={v => onChange({ cardGap: v })}
        />

        {/* Card Inner Padding */}
        <Slider
          label="CARD PADDING"
          value={settings.cardPadding}
          min={0} max={24} step={1}
          unit="px"
          onChange={v => onChange({ cardPadding: v })}
        />

        {/* Layout density. CARDS PER ROW is the CSS grid column count;
            CARDS PER COL is how many rows fit on screen at a time before the
            grid scrolls. Cards always wrap left-to-right, top-to-bottom — the
            (N+1)th card spills onto the next row, the (N*M+1)th below the fold. */}
        <Slider
          label="CARDS PER ROW"
          value={settings.cardsPerRow}
          min={1} max={8} step={1}
          onChange={v => onChange({ cardsPerRow: v })}
          onDragStart={() => onGridDragging?.(true)}
          onDragEnd={() => onGridDragging?.(false)}
        />
        <Slider
          label="CARDS PER COL"
          value={settings.cardsPerCol}
          min={1} max={6} step={1}
          onChange={v => onChange({ cardsPerCol: v })}
          onDragStart={() => onGridDragging?.(true)}
          onDragEnd={() => onGridDragging?.(false)}
        />

        {/* Auto-collapse */}
        <Slider
          label="AUTO-COLLAPSE"
          value={settings.autoCollapseMinutes}
          min={0} max={60} step={5}
          unit={settings.autoCollapseMinutes === 0 ? '' : 'm'}
          onChange={v => onChange({ autoCollapseMinutes: v })}
        />
        {settings.autoCollapseMinutes === 0 && (
          <span className="text-[6px] font-pixel text-white/30 pixel-shadow ml-[108px]">DISABLED</span>
        )}

        {/* Scanlines */}
        <Toggle
          label="SCANLINES"
          checked={settings.scanlines}
          onChange={v => onChange({ scanlines: v })}
        />

        {/* Town card */}
        <Toggle
          label="SHOW TOWN CARD"
          checked={settings.showTownCard}
          onChange={v => onChange({ showTownCard: v })}
        />

        {/* Town debug overlay */}
        <Toggle
          label="TOWN DEBUG GRID"
          checked={settings.townDebug}
          onChange={v => onChange({ townDebug: v })}
        />

        {/* Test Messaging */}
        {onTestMessaging && (
          <button
            onClick={onTestMessaging}
            className="w-full gba-button text-[7px] font-pixel px-3 py-2 transition-colors"
          >
            TEST MESSAGING
          </button>
        )}
      </div>
    </div>
  )
}
