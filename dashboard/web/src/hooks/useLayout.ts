import { useState, useEffect, useCallback } from 'react'

export type LayoutMode = 'standard' | 'standard-short' | 'compact' | 'compact-minimal'

export interface GridLayout {
  cols: number
  mode: LayoutMode
}

const MAX_CELL_WIDTH = 500
const MIN_CELL_WIDTH = 280
const GAP = 8
const PADDING = 24
const HEADER_HEIGHT = 48

const H_STANDARD = 250
const H_STANDARD_SHORT = 180
const H_COMPACT = 128
const H_COMPACT_MINIMAL = 92

export function useGridLayout(
  agentCount: number,
  profileCount?: number,
  agentsPerProfile?: number[]
): GridLayout {
  const [layout, setLayout] = useState<GridLayout>(() =>
    compute(agentCount)
  )

  const recompute = useCallback(() => {
    setLayout(compute(agentCount))
  }, [agentCount])

  useEffect(() => {
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [recompute])

  return layout
}

function compute(agentCount: number): GridLayout {
  if (agentCount === 0) return { cols: 2, mode: 'standard' }

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
