import { useState, useEffect, useCallback } from 'react'

export type LayoutMode = 'max' | 'standard' | 'standard-short' | 'compact' | 'compact-minimal'

export interface GridLayout {
  cols: number
  mode: LayoutMode
}

const MAX_CELL_WIDTH = 500
const MIN_CELL_WIDTH = 280
const GAP = 8
const PADDING = 24
const HEADER_HEIGHT = 48
const GROUP_LABEL_HEIGHT = 22
const GROUP_GAP = 16

const H_MAX = 250
const H_STANDARD = 220
const H_STANDARD_SHORT = 180
const H_COMPACT = 128
const H_COMPACT_MINIMAL = 92

export function useGridLayout(
  agentCount: number,
  profileCount?: number,
  agentsPerProfile?: number[]
): GridLayout {
  const [layout, setLayout] = useState<GridLayout>(() =>
    compute(agentCount, profileCount || 1, agentsPerProfile)
  )

  const recompute = useCallback(() => {
    setLayout(compute(agentCount, profileCount || 1, agentsPerProfile))
  }, [agentCount, profileCount, agentsPerProfile])

  useEffect(() => {
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [recompute])

  return layout
}

function compute(agentCount: number, profileCount: number, agentsPerProfile?: number[]): GridLayout {
  if (agentCount === 0) return { cols: 2, mode: 'max' }

  const w = window.innerWidth - PADDING
  const h = window.innerHeight
  const availableWithHeader = h - HEADER_HEIGHT - PADDING
  const availableNoHeader = h - PADDING

  const maxCols = Math.max(2, Math.floor(w / MIN_CELL_WIDTH))
  let cols = 2
  for (let c = 2; c <= maxCols; c++) {
    const cellW = (w - GAP * (c - 1)) / c
    if (cellW > MAX_CELL_WIDTH && c < maxCols) continue
    cols = c
    break
  }

  // Max mode: count rows PER profile group (each group starts a new row)
  const groupRows = agentsPerProfile
    ? agentsPerProfile.reduce((sum, n) => sum + Math.ceil(n / cols), 0)
    : profileCount // fallback: 1 row per profile
  const maxHeight = groupRows * H_MAX
    + (groupRows - 1) * GAP
    + profileCount * (GROUP_LABEL_HEIGHT + GROUP_GAP)

  if (maxHeight <= availableWithHeader) {
    return { cols, mode: 'max' }
  }

  // Standard and below: flat grid, rows = ceil(total / cols)
  const flatRows = Math.ceil(agentCount / cols)

  const stdHeight = flatRows * H_STANDARD + (flatRows - 1) * GAP
  if (stdHeight <= availableWithHeader) {
    return { cols, mode: 'standard' }
  }

  const stdShortHeight = flatRows * H_STANDARD_SHORT + (flatRows - 1) * GAP
  if (stdShortHeight <= availableWithHeader) {
    return { cols, mode: 'standard-short' }
  }

  const compactHeight = flatRows * H_COMPACT + (flatRows - 1) * GAP
  if (compactHeight <= availableNoHeader) {
    return { cols, mode: 'compact' }
  }

  return { cols, mode: 'compact-minimal' }
}
