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

        {/* Font Size */}
        <OptionGroup
          label="FONT SIZE"
          value={settings.fontSize}
          options={[
            { value: 'small', label: 'SM' },
            { value: 'medium', label: 'MD' },
            { value: 'large', label: 'LG' },
          ]}
          onChange={v => onChange({ fontSize: v })}
        />

        {/* Grid Size */}
        <Slider
          label="COLUMNS"
          value={settings.gridCols}
          min={2} max={8} step={1}
          onChange={v => onChange({ gridCols: v })}
          onDragStart={() => onGridDragging?.(true)}
          onDragEnd={() => onGridDragging?.(false)}
        />
        <Slider
          label="ROWS"
          value={settings.gridRows}
          min={1} max={6} step={1}
          onChange={v => onChange({ gridRows: v })}
          onDragStart={() => onGridDragging?.(true)}
          onDragEnd={() => onGridDragging?.(false)}
        />

        {/* Default Card Size */}
        <div>
          <label className="text-[7px] font-pixel text-white/70 pixel-shadow block mb-1.5">DEFAULT CARD SIZE</label>
          <div className="flex items-center gap-2">
            <span className="text-[6px] font-pixel text-white/40 w-8">W</span>
            <div className="flex gap-1">
              {[1, 2, 3].map(n => (
                <button
                  key={n}
                  onClick={() => onChange({ defaultCardW: n })}
                  className={`text-[7px] font-pixel w-6 h-5 rounded transition-colors ${
                    settings.defaultCardW === n
                      ? 'bg-accent-blue text-white'
                      : 'bg-white/10 text-white/50 hover:bg-white/20'
                  }`}
                  style={{ textShadow: '1px 1px 0 rgba(0,0,0,0.4)' }}
                >{n}</button>
              ))}
            </div>
            <span className="text-[6px] font-pixel text-white/40 w-8 ml-2">H</span>
            <div className="flex gap-1">
              {[1, 2, 3].map(n => (
                <button
                  key={n}
                  onClick={() => onChange({ defaultCardH: n })}
                  className={`text-[7px] font-pixel w-6 h-5 rounded transition-colors ${
                    settings.defaultCardH === n
                      ? 'bg-accent-blue text-white'
                      : 'bg-white/10 text-white/50 hover:bg-white/20'
                  }`}
                  style={{ textShadow: '1px 1px 0 rgba(0,0,0,0.4)' }}
                >{n}</button>
              ))}
            </div>
          </div>
        </div>

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
