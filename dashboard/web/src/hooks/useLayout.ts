import { useState, useEffect, useCallback } from 'react'

export type LayoutMode = 'standard' | 'compact' | 'compact-minimal'

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
const H_COMPACT = 128
const H_COMPACT_MINIMAL = 92

export interface LayoutSettings {
  cardHeight?: number
  cardMinWidth?: number
}

export function useGridLayout(
  agentCount: number,
  layoutSettings?: LayoutSettings,
): GridLayout {
  const minW = layoutSettings?.cardMinWidth || MIN_CELL_WIDTH
  const cardH = layoutSettings?.cardHeight || H_STANDARD

  const [layout, setLayout] = useState<GridLayout>(() =>
    compute(agentCount, minW, cardH)
  )

  const recompute = useCallback(() => {
    setLayout(compute(agentCount, minW, cardH))
  }, [agentCount, minW, cardH])

  useEffect(() => {
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [recompute])

  return layout
}

function compute(agentCount: number, minCellWidth: number, cardHeight: number): GridLayout {
  if (agentCount === 0) return { cols: 2, mode: 'standard' }

  const w = window.innerWidth - PADDING
  const h = window.innerHeight
  const availableWithHeader = h - HEADER_HEIGHT - PADDING
  const availableNoHeader = h - PADDING

  const maxCols = Math.max(2, Math.floor(w / minCellWidth))
  let cols = 2
  for (let c = 2; c <= maxCols; c++) {
    const cellW = (w - GAP * (c - 1)) / c
    if (cellW > MAX_CELL_WIDTH && c < maxCols) continue
    cols = c
    break
  }

  const flatRows = Math.ceil(agentCount / cols)

  const stdHeight = flatRows * cardHeight + (flatRows - 1) * GAP
  if (stdHeight <= availableWithHeader) {
    return { cols, mode: 'standard' }
  }

  const compactHeight = flatRows * H_COMPACT + (flatRows - 1) * GAP
  if (compactHeight <= availableNoHeader) {
    return { cols, mode: 'compact' }
  }

  return { cols, mode: 'compact-minimal' }
}
