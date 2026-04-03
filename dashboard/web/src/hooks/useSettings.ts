import { useState, useEffect, useCallback } from 'react'

export interface DashboardSettings {
  gridRows: number            // grid rows (1-8)
  gridCols: number            // grid columns (2-10)
  defaultCardW: number        // default card width in grid cells
  defaultCardH: number        // default card height in grid cells
  fontSize: 'small' | 'medium' | 'large'
  theme: 'fire-red' | 'classic'
  autoCollapseMinutes: number // 0 = disabled, otherwise minutes
  scanlines: boolean          // show GBA scanline overlay
}

const DEFAULTS: DashboardSettings = {
  gridRows: 3,
  gridCols: 4,
  defaultCardW: 2,
  defaultCardH: 2,
  fontSize: 'medium',
  theme: 'fire-red',
  autoCollapseMinutes: 15,
  scanlines: true,
}

const STORAGE_KEY = 'pokegents-settings'

function load(): DashboardSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return DEFAULTS
  }
}

export function useSettings() {
  const [settings, setSettingsState] = useState<DashboardSettings>(load)

  const setSettings = useCallback((update: Partial<DashboardSettings>) => {
    setSettingsState(prev => {
      const next = { ...prev, ...update }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setSettingsState(DEFAULTS)
  }, [])

  // Apply theme class to body
  useEffect(() => {
    document.body.classList.toggle('theme-classic', settings.theme === 'classic')
    document.body.classList.toggle('theme-fire-red', settings.theme === 'fire-red')
    document.body.classList.toggle('no-scanlines', !settings.scanlines)
  }, [settings.theme, settings.scanlines])

  // Apply font size class to body
  useEffect(() => {
    document.body.classList.remove('font-size-small', 'font-size-medium', 'font-size-large')
    document.body.classList.add(`font-size-${settings.fontSize}`)
  }, [settings.fontSize])

  return { settings, setSettings, reset, DEFAULTS }
}

// Font size multiplier for components to use
export function fontScale(size: DashboardSettings['fontSize']): number {
  if (size === 'small') return 0.85
  if (size === 'large') return 1.2
  return 1
}
