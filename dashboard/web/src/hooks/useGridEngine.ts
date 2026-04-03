import { useState, useEffect, useCallback, useRef, useMemo } from 'react'

// ── Types ──────────────────────────────────────────────────

export interface GridRect {
  col: number  // 1-indexed
  row: number  // 1-indexed
  w: number    // span in grid cells
  h: number    // span in grid cells
}

export interface GridSettings {
  rows: number
  cols: number
  defaultCardW: number
  defaultCardH: number
}

export interface GridLayoutData {
  settings: GridSettings
  layouts: Record<string, GridRect>
}

export type CardMode = 'standard' | 'compact' | 'compact-minimal'

export interface DragState {
  id: string
  startCell: { col: number; row: number }
  startPointer: { x: number; y: number }
  ghostOffset: { x: number; y: number }
}

export interface ResizeState {
  id: string
  startX: number
  startY: number
  startW: number
  startH: number
}

const DEFAULT_SETTINGS: GridSettings = {
  rows: 3,
  cols: 4,
  defaultCardW: 2,
  defaultCardH: 2,
}

const GAP = 8
const PADDING = 24
const HEADER_H = 48

// ── Pure grid math ─────────────────────────────────────────

export function cellDimensions(
  viewportW: number,
  viewportH: number,
  cols: number,
  rows: number,
  headerH: number = HEADER_H,
): { cellW: number; cellH: number } {
  const cellW = (viewportW - PADDING - (cols - 1) * GAP) / cols
  const cellH = (viewportH - headerH - PADDING - (rows - 1) * GAP) / rows
  return { cellW: Math.max(cellW, 80), cellH: Math.max(cellH, 60) }
}

export function cardMode(pixelHeight: number): CardMode {
  if (pixelHeight >= 200) return 'standard'
  if (pixelHeight >= 120) return 'compact'
  return 'compact-minimal'
}

/** Check if two rects overlap */
export function overlaps(a: GridRect, b: GridRect): boolean {
  return (
    a.col < b.col + b.w &&
    a.col + a.w > b.col &&
    a.row < b.row + b.h &&
    a.row + a.h > b.row
  )
}

/** Check if a rect fits without overlapping any existing rects */
function canFit(
  occupied: Record<string, GridRect>,
  skipId: string | null,
  col: number,
  row: number,
  w: number,
  h: number,
  cols: number,
): boolean {
  if (col + w - 1 > cols) return false
  const candidate: GridRect = { col, row, w, h }
  for (const [id, rect] of Object.entries(occupied)) {
    if (id === skipId) continue
    if (overlaps(candidate, rect)) return false
  }
  return true
}

/** First-fit row-major placement */
export function placeCard(
  occupied: Record<string, GridRect>,
  w: number,
  h: number,
  cols: number,
): { col: number; row: number } {
  for (let row = 1; row <= 100; row++) {
    for (let col = 1; col <= cols - w + 1; col++) {
      if (canFit(occupied, null, col, row, w, h, cols)) {
        return { col, row }
      }
    }
  }
  // Fallback: extend grid vertically
  return { col: 1, row: 100 }
}

/** Resolve all collisions after moving/resizing `movedId`.
 *  Displaced cards are bumped to the next available slot (row-major). */
export function resolveCollisions(
  layouts: Record<string, GridRect>,
  movedId: string,
  cols: number,
): Record<string, GridRect> {
  const result = { ...layouts }
  const moved = result[movedId]
  if (!moved) return result

  // Find all cards that overlap the moved card (excluding itself)
  const displaced: string[] = []
  for (const [id, rect] of Object.entries(result)) {
    if (id !== movedId && overlaps(moved, rect)) {
      displaced.push(id)
    }
  }

  // Sort displaced by their original position (row-major) so we process top-left first
  displaced.sort((a, b) => {
    const ra = result[a], rb = result[b]
    return ra.row !== rb.row ? ra.row - rb.row : ra.col - rb.col
  })

  // For each displaced card, find next available slot
  for (const id of displaced) {
    const card = result[id]
    const pos = findNextFree(result, id, card.w, card.h, cols)
    result[id] = { ...card, ...pos }
  }

  // Cascading: the displaced cards may now overlap other cards
  // Run a few passes to settle
  for (let iter = 0; iter < 30; iter++) {
    let settled = true
    const ids = Object.keys(result)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (overlaps(result[ids[i]], result[ids[j]])) {
          // Push the one that's lower/righter (later in row-major order)
          const [keepId, pushId] =
            result[ids[i]].row < result[ids[j]].row ||
            (result[ids[i]].row === result[ids[j]].row && result[ids[i]].col <= result[ids[j]].col)
              ? [ids[i], ids[j]]
              : [ids[j], ids[i]]
          const pushCard = result[pushId]
          const pos = findNextFree(result, pushId, pushCard.w, pushCard.h, cols)
          result[pushId] = { ...pushCard, ...pos }
          settled = false
        }
      }
    }
    if (settled) break
  }

  return result
}

/** Find the next free position for a card of size w×h, scanning row-major.
 *  Starts from row 1, col 1 to find the earliest available slot. */
function findNextFree(
  layouts: Record<string, GridRect>,
  skipId: string,
  w: number,
  h: number,
  cols: number,
): { col: number; row: number } {
  for (let row = 1; row <= 200; row++) {
    for (let col = 1; col <= cols - w + 1; col++) {
      if (canFit(layouts, skipId, col, row, w, h, cols)) {
        return { col, row }
      }
    }
  }
  return { col: 1, row: 200 }
}

/** Move all cards up as high as possible without overlapping.
 *  Tries same column first, then any column. Process top-to-bottom
 *  so upper cards stay put and lower cards slide up. */
export function compactUp(
  layouts: Record<string, GridRect>,
  cols: number,
): Record<string, GridRect> {
  const result: Record<string, GridRect> = {}

  // Process cards top-to-bottom, left-to-right
  const sorted = Object.keys(layouts).sort((a, b) => {
    const ra = layouts[a], rb = layouts[b]
    return ra.row !== rb.row ? ra.row - rb.row : ra.col - rb.col
  })

  for (const id of sorted) {
    const card = layouts[id]
    if (!card) continue

    let bestRow = card.row
    let bestCol = card.col

    // First: try to move up keeping same column
    for (let row = 1; row < card.row; row++) {
      if (canFit(result, null, card.col, row, card.w, card.h, cols)) {
        bestRow = row
        break
      }
    }

    // If same-column didn't help, try any column at the earliest row
    if (bestRow === card.row) {
      outer:
      for (let row = 1; row < card.row; row++) {
        for (let col = 1; col <= cols - card.w + 1; col++) {
          if (canFit(result, null, col, row, card.w, card.h, cols)) {
            bestRow = row
            bestCol = col
            break outer
          }
        }
      }
    }

    result[id] = { ...card, col: bestCol, row: bestRow }
  }

  return result
}

/** Reflow layouts when column count changes. Keeps positions when possible,
 *  only moves cards that overflow the new column count. */
export function reflowLayouts(
  layouts: Record<string, GridRect>,
  newCols: number,
  _agentOrder: string[],
): Record<string, GridRect> {
  const result: Record<string, GridRect> = {}
  const displaced: string[] = []

  // First pass: keep cards that still fit, collect those that don't
  const sorted = Object.keys(layouts).sort((a, b) => {
    const ra = layouts[a], rb = layouts[b]
    return ra.row !== rb.row ? ra.row - rb.row : ra.col - rb.col
  })

  for (const id of sorted) {
    const old = layouts[id]
    if (!old) continue
    const w = Math.min(old.w, newCols)
    // Card fits if its right edge is within the new col count
    if (old.col + w - 1 <= newCols) {
      result[id] = { ...old, w }
    } else {
      // Try to keep same row, shift left to fit
      const newCol = Math.max(1, newCols - w + 1)
      const candidate = { col: newCol, row: old.row, w, h: old.h }
      const hasConflict = Object.values(result).some(r => overlaps(candidate, r))
      if (!hasConflict) {
        result[id] = candidate
      } else {
        displaced.push(id)
      }
    }
  }

  // Second pass: place displaced cards into first available slot
  for (const id of displaced) {
    const old = layouts[id]
    const w = Math.min(old.w, newCols)
    const pos = placeCard(result, w, old.h, newCols)
    result[id] = { col: pos.col, row: pos.row, w, h: old.h }
  }

  return result
}

// ── Hook ───────────────────────────────────────────────────

export interface GridEngine {
  // Layout state
  layouts: Record<string, GridRect>
  settings: GridSettings
  cellW: number
  cellH: number
  maxRow: number

  // Card mode for a given card
  getCardMode: (id: string) => CardMode

  // Ensure a card has a layout (for new agents)
  ensureLayout: (id: string) => void

  // Direct layout manipulation
  setLayouts: (layouts: Record<string, GridRect>) => void

  // Convert a grid rect to a pixel DOMRect (relative to viewport)
  gridRectToPixels: (rect: GridRect) => DOMRect

  // Settings
  updateSettings: (partial: Partial<GridSettings>) => void

  // Drag & drop
  dragState: DragState | null
  startDrag: (id: string, pointerX: number, pointerY: number, cardEl: HTMLElement) => void
  updateDrag: (pointerX: number, pointerY: number) => void
  endDrag: () => void
  cancelDrag: () => void

  // Resize
  resizeState: ResizeState | null
  startResize: (id: string, pointerX: number, pointerY: number) => void
  updateResize: (pointerX: number, pointerY: number) => void
  endResize: () => void

  // Grid ref for coordinate conversion
  gridRef: React.RefObject<HTMLDivElement | null>

  // Preview layouts during drag/resize (for animation)
  previewLayouts: Record<string, GridRect> | null

  // Compact / reset
  compactUp: () => void
  resetSizes: () => void

  // Persistence
  saveProfile: (name: string) => Promise<void>
  loadProfile: (name: string) => Promise<void>
  deleteProfile: (name: string) => Promise<void>
  listProfiles: () => Promise<string[]>
}

export function useGridEngine(
  agentIds: string[],
  initialSettings?: Partial<GridSettings>,
): GridEngine {
  const [settings, setSettings] = useState<GridSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...initialSettings,
  }))

  const [layouts, setLayoutsState] = useState<Record<string, GridRect>>({})
  const [previewLayouts, setPreviewLayouts] = useState<Record<string, GridRect> | null>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [resizeState, setResizeState] = useState<ResizeState | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const loadedRef = useRef(false)

  // ── Sync external settings changes (from settings panel) ──
  useEffect(() => {
    if (!initialSettings) return
    setSettings(prev => {
      const next = { ...prev, ...initialSettings }
      const changed = next.cols !== prev.cols || next.rows !== prev.rows ||
          next.defaultCardW !== prev.defaultCardW || next.defaultCardH !== prev.defaultCardH
      if (!changed) return prev

      // Only reflow card positions when column count changes
      if (next.cols !== prev.cols) {
        setLayoutsState(current => {
          const reflowed = reflowLayouts(current, next.cols, agentIds)
          persistLayouts(reflowed, next)
          return reflowed
        })
      } else {
        // Rows/defaultCardW/H changed — just persist settings, don't move cards
        setLayoutsState(current => {
          persistLayouts(current, next)
          return current
        })
      }
      return next
    })
  }, [initialSettings?.rows, initialSettings?.cols, initialSettings?.defaultCardW, initialSettings?.defaultCardH])

  // ── Cell dimensions: observed from scroll container ──
  const [dims, setDims] = useState(() =>
    cellDimensions(window.innerWidth, window.innerHeight, settings.cols, settings.rows)
  )

  useEffect(() => {
    const measure = () => {
      const el = gridRef.current
      const container = el?.parentElement // the scrollable flex-1 div
      if (!container) {
        setDims(cellDimensions(window.innerWidth, window.innerHeight, settings.cols, settings.rows))
        return
      }
      const w = container.clientWidth
      const h = container.clientHeight
      const cellW = Math.max(80, (w - (settings.cols - 1) * GAP) / settings.cols)
      const cellH = Math.max(60, (h - (settings.rows - 1) * GAP) / settings.rows)
      setDims(prev => (Math.abs(prev.cellW - cellW) < 1 && Math.abs(prev.cellH - cellH) < 1) ? prev : { cellW, cellH })
    }
    // Measure after layout settles
    requestAnimationFrame(() => requestAnimationFrame(measure))
    const ro = new ResizeObserver(measure)
    const container = gridRef.current?.parentElement
    if (container) ro.observe(container)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [settings.cols, settings.rows])

  // ── Load layout from backend on mount ──
  useEffect(() => {
    fetch('/api/grid-layout')
      .then(r => r.ok ? r.json() : null)
      .then((data: GridLayoutData | null) => {
        if (data) {
          if (data.settings) setSettings(prev => ({ ...prev, ...data.settings }))
          if (data.layouts) setLayoutsState(data.layouts)
        }
        loadedRef.current = true
      })
      .catch(() => { loadedRef.current = true })
  }, [])

  // ── Auto-persist on layout change (debounced) ──
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistLayouts = useCallback((l: Record<string, GridRect>, s: GridSettings) => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      fetch('/api/grid-layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: s, layouts: l }),
      }).catch(() => {})
    }, 500)
  }, [])

  // ── Prune stale layouts + ensure all visible agents have layouts ──
  const agentIdSet = useMemo(() => new Set(agentIds), [agentIds])

  useEffect(() => {
    if (!loadedRef.current) return
    setLayoutsState(prev => {
      let changed = false
      const next: Record<string, GridRect> = {}

      // Only keep layouts for agents that currently exist (prune ghosts)
      for (const [id, rect] of Object.entries(prev)) {
        if (agentIdSet.has(id)) {
          next[id] = rect
        } else {
          changed = true // pruned a stale entry
        }
      }

      // Ensure all visible agents have a layout
      for (const id of agentIds) {
        if (!next[id]) {
          const pos = placeCard(next, settings.defaultCardW, settings.defaultCardH, settings.cols)
          next[id] = { ...pos, w: settings.defaultCardW, h: settings.defaultCardH }
          changed = true
        } else {
          // Check if saved position conflicts with another visible agent
          const saved = next[id]
          const hasConflict = Object.entries(next).some(([otherId, otherRect]) =>
            otherId !== id && overlaps(saved, otherRect)
          )
          if (hasConflict) {
            // Reposition but keep original size
            const w = Math.min(saved.w, settings.cols)
            const pos = placeCard(next, w, saved.h, settings.cols)
            next[id] = { ...pos, w, h: saved.h }
            changed = true
          }
        }
      }
      if (changed) persistLayouts(next, settings)
      return changed ? next : prev
    })
  }, [agentIds, agentIdSet, settings.cols, settings.defaultCardW, settings.defaultCardH, loadedRef.current])

  const ensureLayout = useCallback((id: string) => {
    setLayoutsState(prev => {
      if (prev[id]) return prev
      const pos = placeCard(prev, settings.defaultCardW, settings.defaultCardH, settings.cols)
      const next = { ...prev, [id]: { ...pos, w: settings.defaultCardW, h: settings.defaultCardH } }
      persistLayouts(next, settings)
      return next
    })
  }, [settings, persistLayouts])

  // ── Max row (for grid height / scrolling) ──
  const activeLayouts = previewLayouts || layouts
  const maxRow = useMemo(() => {
    let max = settings.rows
    for (const rect of Object.values(activeLayouts)) {
      max = Math.max(max, rect.row + rect.h - 1)
    }
    return max
  }, [activeLayouts, settings.rows])

  // ── Card mode ──
  const getCardMode = useCallback((id: string): CardMode => {
    const rect = activeLayouts[id]
    if (!rect) return 'standard'
    const pixelH = rect.h * dims.cellH + (rect.h - 1) * GAP
    return cardMode(pixelH)
  }, [activeLayouts, dims.cellH])

  // ── Settings update with reflow ──
  const updateSettings = useCallback((partial: Partial<GridSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial }
      // Reflow if cols changed
      if (partial.cols && partial.cols !== prev.cols) {
        setLayoutsState(current => {
          const reflowed = reflowLayouts(current, next.cols, agentIds)
          persistLayouts(reflowed, next)
          return reflowed
        })
      } else {
        persistLayouts(layouts, next)
      }
      return next
    })
  }, [agentIds, layouts, persistLayouts])

  // ── Grid coordinate conversion ──
  const pointerToCell = useCallback((px: number, py: number): { col: number; row: number } => {
    if (!gridRef.current) return { col: 1, row: 1 }
    const rect = gridRef.current.getBoundingClientRect()
    const x = px - rect.left
    const y = py - rect.top + gridRef.current.scrollTop
    const colW = dims.cellW + GAP
    const rowH = dims.cellH + GAP
    const col = Math.max(1, Math.min(settings.cols, Math.floor(x / colW) + 1))
    const row = Math.max(1, Math.floor(y / rowH) + 1)
    return { col, row }
  }, [dims, settings.cols])

  // ── Drag & Drop ──────────────────────────────────────────

  const startDrag = useCallback((id: string, pointerX: number, pointerY: number, cardEl: HTMLElement) => {
    const cardRect = cardEl.getBoundingClientRect()
    setDragState({
      id,
      startCell: { col: layouts[id]?.col ?? 1, row: layouts[id]?.row ?? 1 },
      startPointer: { x: pointerX, y: pointerY },
      ghostOffset: { x: pointerX - cardRect.left, y: pointerY - cardRect.top },
    })
  }, [layouts])

  const lastDragCell = useRef('')
  const updateDrag = useCallback((pointerX: number, pointerY: number) => {
    if (!dragState) return
    const rect = layouts[dragState.id]
    if (!rect) return

    // Delta-based: how many cells has the pointer moved from where we started?
    const colUnit = dims.cellW + GAP
    const rowUnit = dims.cellH + GAP
    const deltaX = pointerX - dragState.startPointer.x
    const deltaY = pointerY - dragState.startPointer.y
    const deltaCols = Math.round(deltaX / colUnit)
    const deltaRows = Math.round(deltaY / rowUnit)
    const targetCol = dragState.startCell.col + deltaCols
    const targetRow = dragState.startCell.row + deltaRows

    // Clamp so card doesn't overflow grid columns
    const clampedCol = Math.max(1, Math.min(targetCol, settings.cols - rect.w + 1))
    const clampedRow = Math.max(1, targetRow)
    const cellKey = `${clampedCol},${clampedRow}`
    if (cellKey === lastDragCell.current) return
    lastDragCell.current = cellKey

    // Compute preview: move card, resolve collisions
    const tentative = { ...layouts, [dragState.id]: { ...rect, col: clampedCol, row: clampedRow } }
    const resolved = resolveCollisions(tentative, dragState.id, settings.cols)
    setPreviewLayouts(resolved)
  }, [dragState, layouts, settings.cols, pointerToCell])

  const endDrag = useCallback(() => {
    if (previewLayouts) {
      // Auto-compact after drag so displaced cards don't stay stranded
      const compacted = compactUp(previewLayouts, settings.cols)
      setLayoutsState(compacted)
      persistLayouts(compacted, settings)
    }
    setPreviewLayouts(null)
    setDragState(null)
    lastDragCell.current = ''
  }, [previewLayouts, settings, persistLayouts])

  const cancelDrag = useCallback(() => {
    setPreviewLayouts(null)
    setDragState(null)
    lastDragCell.current = ''
  }, [])

  // Escape key to cancel drag
  useEffect(() => {
    if (!dragState) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrag()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dragState, cancelDrag])

  // ── Resize ───────────────────────────────────────────────

  const startResize = useCallback((id: string, pointerX: number, pointerY: number) => {
    const rect = layouts[id]
    if (!rect) return
    setResizeState({ id, startX: pointerX, startY: pointerY, startW: rect.w, startH: rect.h })
  }, [layouts])

  const lastResizeSize = useRef<string>('')
  const updateResize = useCallback((pointerX: number, pointerY: number) => {
    if (!resizeState) return
    // Use the COMMITTED layout for the card's position (col/row don't change during resize)
    const baseRect = layouts[resizeState.id]
    if (!baseRect) return

    const deltaX = pointerX - resizeState.startX
    const deltaY = pointerY - resizeState.startY
    const colUnit = dims.cellW + GAP
    const rowUnit = dims.cellH + GAP
    const totalW = resizeState.startW * dims.cellW + (resizeState.startW - 1) * GAP + deltaX
    const totalH = resizeState.startH * dims.cellH + (resizeState.startH - 1) * GAP + deltaY
    const newW = Math.max(1, Math.min(settings.cols - baseRect.col + 1, Math.round((totalW + GAP) / colUnit)))
    const newH = Math.max(1, Math.round((totalH + GAP) / rowUnit))

    // Debounce: only recompute if size actually changed
    const sizeKey = `${newW},${newH}`
    if (sizeKey === lastResizeSize.current) return
    lastResizeSize.current = sizeKey

    // Build tentative from committed layouts (not preview) with just the resized card changed
    const tentative = { ...layouts, [resizeState.id]: { ...baseRect, w: newW, h: newH } }
    const resolved = resolveCollisions(tentative, resizeState.id, settings.cols)
    setPreviewLayouts(resolved)
  }, [resizeState, layouts, dims, settings.cols])

  const endResize = useCallback(() => {
    if (previewLayouts) {
      // Auto-compact after resize so displaced cards don't stay stranded
      const compacted = compactUp(previewLayouts, settings.cols)
      setLayoutsState(compacted)
      persistLayouts(compacted, settings)
    }
    setPreviewLayouts(null)
    setResizeState(null)
    lastResizeSize.current = ''
  }, [previewLayouts, settings, persistLayouts])

  // ── Compact up ───────────────────────────────────────────

  const compactUpAction = useCallback(() => {
    setLayoutsState(prev => {
      const compacted = compactUp(prev, settings.cols)
      persistLayouts(compacted, settings)
      return compacted
    })
  }, [settings, persistLayouts])

  const resetSizesAction = useCallback(() => {
    setLayoutsState(_prev => {
      // Reset all cards to default size and repack from scratch
      const result: Record<string, GridRect> = {}
      const { defaultCardW: w, defaultCardH: h, cols } = settings
      for (const id of agentIds) {
        const pos = placeCard(result, w, h, cols)
        result[id] = { ...pos, w, h }
      }
      persistLayouts(result, settings)
      return result
    })
  }, [agentIds, settings, persistLayouts])

  // ── Profiles ─────────────────────────────────────────────

  const saveProfile = useCallback(async (name: string) => {
    await fetch(`/api/grid-profiles/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, layouts }),
    })
  }, [settings, layouts])

  const loadProfile = useCallback(async (name: string) => {
    const res = await fetch(`/api/grid-profiles/${encodeURIComponent(name)}`)
    if (!res.ok) return
    const data: GridLayoutData = await res.json()
    if (data.settings) setSettings(prev => ({ ...prev, ...data.settings }))
    if (data.layouts) {
      // Reflow: agents in saved profile get their positions, new agents get placed
      const reflowed = { ...data.layouts }
      for (const id of agentIds) {
        if (!reflowed[id]) {
          const pos = placeCard(reflowed, data.settings?.defaultCardW ?? settings.defaultCardW, data.settings?.defaultCardH ?? settings.defaultCardH, data.settings?.cols ?? settings.cols)
          reflowed[id] = { ...pos, w: data.settings?.defaultCardW ?? settings.defaultCardW, h: data.settings?.defaultCardH ?? settings.defaultCardH }
        }
      }
      setLayoutsState(reflowed)
      persistLayouts(reflowed, data.settings || settings)
    }
  }, [agentIds, settings, persistLayouts])

  const deleteProfile = useCallback(async (name: string) => {
    await fetch(`/api/grid-profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })
  }, [])

  const listProfiles = useCallback(async (): Promise<string[]> => {
    const res = await fetch('/api/grid-profiles')
    if (!res.ok) return []
    const data = await res.json()
    return data.profiles || []
  }, [])

  // ── Public setLayouts ──
  const setLayouts = useCallback((newLayouts: Record<string, GridRect>) => {
    setLayoutsState(newLayouts)
    persistLayouts(newLayouts, settings)
  }, [settings, persistLayouts])

  const gridRectToPixels = useCallback((rect: GridRect): DOMRect => {
    const gridEl = gridRef.current
    const gridBounds = gridEl?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
    const x = gridBounds.left + (rect.col - 1) * (dims.cellW + GAP)
    const y = gridBounds.top + (rect.row - 1) * (dims.cellH + GAP) - (gridEl?.scrollTop ?? 0)
    const w = rect.w * dims.cellW + (rect.w - 1) * GAP
    const h = rect.h * dims.cellH + (rect.h - 1) * GAP
    return new DOMRect(x, y, w, h)
  }, [dims])

  return {
    layouts: activeLayouts,
    settings,
    cellW: dims.cellW,
    cellH: dims.cellH,
    maxRow,
    getCardMode,
    ensureLayout,
    setLayouts,
    gridRectToPixels,
    updateSettings,
    dragState,
    startDrag,
    updateDrag,
    endDrag,
    cancelDrag,
    resizeState,
    startResize,
    updateResize,
    endResize,
    gridRef,
    previewLayouts,
    compactUp: compactUpAction,
    resetSizes: resetSizesAction,
    saveProfile,
    loadProfile,
    deleteProfile,
    listProfiles,
  }
}
