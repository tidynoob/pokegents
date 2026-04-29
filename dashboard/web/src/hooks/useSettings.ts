import { useState, useEffect, useCallback } from 'react'

export interface DashboardSettings {
  gridRows: number            // grid rows (1-8)
  gridCols: number            // grid columns (2-10)
  defaultCardW: number        // legacy: minimum card width in grid cells
  defaultCardH: number        // legacy: minimum card height in grid cells
  cardsPerRow: number         // target cards per row at reset / new-agent placement
  cardsPerCol: number         // target cards per column at reset / new-agent placement
  cardGap: number             // spacing between cards in px (0 = flush)
  cardPadding: number         // inner padding of each card in px (between border and content)
  outputFontSize: number      // agent card output font size in px
  theme: 'fire-red' | 'classic'
  autoCollapseMinutes: number // 0 = disabled, otherwise minutes
  scanlines: boolean          // show GBA scanline overlay
  townDebug: boolean          // overlay walkable-mask grid on the town view
  showTownCard: boolean       // include town as a card in the main grid
}

const DEFAULTS: DashboardSettings = {
  gridRows: 3,
  gridCols: 4,
  defaultCardW: 1,
  defaultCardH: 1,
  cardsPerRow: 3,
  cardsPerCol: 3,
  cardGap: 8,
  cardPadding: 16,
  outputFontSize: 11,
  theme: 'fire-red',
  autoCollapseMinutes: 0,
  scanlines: true,
  townDebug: false,
  showTownCard: true,
}

const STORAGE_KEY = 'pokegents-settings'

const AUTO_COLLAPSE_DISABLE_MIGRATION_KEY = 'pokegents-migrated-autocollapse-off-v1'

function load(): DashboardSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw)
    // One-time migration: force auto-collapse off for everyone. Runs exactly once
    // (guarded by a separate localStorage flag) so users who later re-enable it
    // in Settings don't get reset on subsequent loads.
    if (!localStorage.getItem(AUTO_COLLAPSE_DISABLE_MIGRATION_KEY)) {
      parsed.autoCollapseMinutes = 0
      localStorage.setItem(AUTO_COLLAPSE_DISABLE_MIGRATION_KEY, '1')
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
    }
    return { ...DEFAULTS, ...parsed }
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

  // Apply output font size as CSS variable
  useEffect(() => {
    document.documentElement.style.setProperty('--output-font-size', `${settings.outputFontSize}px`)
  }, [settings.outputFontSize])

  // Apply inner card padding as CSS variable (consumed by AgentCard)
  useEffect(() => {
    document.documentElement.style.setProperty('--card-padding', `${settings.cardPadding}px`)
  }, [settings.cardPadding])

  return { settings, setSettings, reset, DEFAULTS }
}
