import { useRef, useEffect, useState, useCallback } from 'react'
import type { GridEngine, GridRect } from '../hooks/useGridEngine'

const GAP = 8

interface GridContainerProps {
  engine: GridEngine
  children: (id: string, rect: GridRect, mode: ReturnType<GridEngine['getCardMode']>) => React.ReactNode
  agentIds: string[]
  showHeader: boolean
  showGridLines?: boolean
}

export function GridContainer({ engine, children, agentIds, showHeader, showGridLines }: GridContainerProps) {
  const { layouts, settings, cellW, cellH, maxRow, getCardMode, dragState, gridRef } = engine
  const isDragging = !!dragState
  const isResizing = !!engine.resizeState

  // Ghost element for drag
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null)
  const [ghostSize, setGhostSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // Use refs for callbacks to avoid stale closures in event listeners
  const engineRef = useRef(engine)
  engineRef.current = engine
  const dragStateRef = useRef(dragState)
  dragStateRef.current = dragState

  // Pointer move / up handlers (document-level during drag/resize)
  useEffect(() => {
    if (!isDragging && !isResizing) return

    const onMove = (e: PointerEvent) => {
      const eng = engineRef.current
      const ds = dragStateRef.current
      if (ds) {
        eng.updateDrag(e.clientX, e.clientY)
        setGhostPos({
          x: e.clientX - ds.ghostOffset.x,
          y: e.clientY - ds.ghostOffset.y,
        })
      }
      if (eng.resizeState) {
        eng.updateResize(e.clientX, e.clientY)
      }
    }

    const onUp = () => {
      const eng = engineRef.current
      if (eng.dragState) eng.endDrag()
      if (eng.resizeState) eng.endResize()
      setGhostPos(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [isDragging, isResizing])

  // Set ghost size when drag starts
  useEffect(() => {
    if (dragState) {
      const rect = layouts[dragState.id]
      if (rect) {
        setGhostSize({
          w: rect.w * cellW + (rect.w - 1) * GAP,
          h: rect.h * cellH + (rect.h - 1) * GAP,
        })
      }
    }
  }, [dragState, layouts, cellW, cellH])

  const gridRows = Math.max(settings.rows, maxRow)

  return (
    <div className="flex-1 min-h-0" style={{ overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
      <div
        ref={gridRef}
        className="grid content-start items-start"
        style={{
          gridTemplateColumns: `repeat(${settings.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${gridRows}, ${cellH}px)`,
          gridAutoRows: cellH,
          gap: GAP,
          paddingBottom: 40,
          position: 'relative',
        }}
      >
        {/* Grid lines — absolute positioned, visible during drag/resize/settings */}
        {(isDragging || isResizing || showGridLines) && (
          <div className="pointer-events-none" style={{
            position: 'absolute', inset: 0, zIndex: 1,
          }}>
            {/* Vertical lines between columns */}
            {Array.from({ length: settings.cols - 1 }, (_, i) => {
              const x = (i + 1) * (cellW + GAP) - GAP / 2
              return (
                <div
                  key={`vline-${i}`}
                  style={{
                    position: 'absolute',
                    left: x,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    backgroundImage: 'repeating-linear-gradient(180deg, rgba(255,255,255,0.18) 0px, rgba(255,255,255,0.18) 4px, transparent 4px, transparent 8px)',
                  }}
                />
              )
            })}
            {/* Horizontal lines between rows */}
            {Array.from({ length: gridRows - 1 }, (_, i) => {
              const y = (i + 1) * (cellH + GAP) - GAP / 2
              return (
                <div
                  key={`hline-${i}`}
                  style={{
                    position: 'absolute',
                    top: y,
                    left: 0,
                    right: 0,
                    height: 2,
                    backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.12) 0px, rgba(255,255,255,0.12) 4px, transparent 4px, transparent 8px)',
                  }}
                />
              )
            })}
          </div>
        )}

        {/* Cards */}
        {agentIds.map(id => {
          const rect = layouts[id]
          if (!rect) return null
          const mode = getCardMode(id)
          const isDraggedCard = dragState?.id === id
          return (
            <GridCell
              key={id}
              id={id}
              rect={rect}
              cellW={cellW}
              cellH={cellH}
              mode={mode}
              isDragging={isDraggedCard}
              isAnyDragging={isDragging}
              isResizing={isResizing}
              engine={engine}
            >
              {children(id, rect, mode)}
            </GridCell>
          )
        })}
      </div>

      {/* Drag ghost — floating element that follows cursor */}
      {isDragging && dragState && ghostPos && (
        <div
          className="fixed pointer-events-none z-50"
          style={{
            left: ghostPos.x,
            top: ghostPos.y,
            width: ghostSize.w,
            height: ghostSize.h,
            opacity: 0.7,
            transform: 'scale(1.02)',
            filter: 'brightness(1.1)',
          }}
        >
          {(() => {
            const rect = layouts[dragState.id]
            if (!rect) return null
            return children(dragState.id, rect, getCardMode(dragState.id))
          })()}
        </div>
      )}
    </div>
  )
}

// ── GridCell — positions and animates a single card ────────

interface GridCellProps {
  id: string
  rect: GridRect
  cellW: number
  cellH: number
  mode: ReturnType<GridEngine['getCardMode']>
  isDragging: boolean
  isAnyDragging: boolean
  isResizing: boolean
  engine: GridEngine
  children: React.ReactNode
}

function GridCell({
  id,
  rect,
  cellW,
  cellH,
  mode,
  isDragging,
  isAnyDragging,
  isResizing,
  engine,
  children,
}: GridCellProps) {
  const cellRef = useRef<HTMLDivElement>(null)
  const dragThreshold = useRef<{ startX: number; startY: number; started: boolean } | null>(null)
  const engineRef = useRef(engine)
  engineRef.current = engine

  // FLIP animation: when grid position changes, animate from old to new
  const prevRect = useRef(rect)
  useEffect(() => {
    const prev = prevRect.current
    prevRect.current = rect
    if (!cellRef.current || isDragging) return
    if (prev.col === rect.col && prev.row === rect.row && prev.w === rect.w && prev.h === rect.h) return

    const dx = (prev.col - rect.col) * (cellW + GAP)
    const dy = (prev.row - rect.row) * (cellH + GAP)
    if (dx === 0 && dy === 0) return

    const el = cellRef.current
    // Invert: snap to old position
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
    // Play: animate to new position
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'transform 500ms cubic-bezier(0.2, 0, 0, 1)'
        el.style.transform = 'translate(0, 0)'
      })
    })
  }, [rect.col, rect.row, rect.w, rect.h, cellW, cellH, isDragging])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Don't start drag from inputs, textareas, or elements marked no-drag
    const el = e.target as HTMLElement
    if (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.closest('[data-no-drag]') ||
      el.closest('button')
    ) return

    // Start tracking for drag threshold
    dragThreshold.current = { startX: e.clientX, startY: e.clientY, started: false }

    const onMove = (me: PointerEvent) => {
      if (!dragThreshold.current) return
      const dx = me.clientX - dragThreshold.current.startX
      const dy = me.clientY - dragThreshold.current.startY
      if (!dragThreshold.current.started && Math.abs(dx) + Math.abs(dy) > 5) {
        dragThreshold.current.started = true
        if (cellRef.current) {
          engineRef.current.startDrag(id, dragThreshold.current.startX, dragThreshold.current.startY, cellRef.current)
        }
      }
    }

    const onUp = () => {
      dragThreshold.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [id])

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    engineRef.current.startResize(id, e.clientX, e.clientY)
  }, [id])

  const h = rect.h * cellH + (rect.h - 1) * GAP
  const isCompact = mode === 'compact' || mode === 'compact-minimal'

  return (
    <div
      ref={cellRef}
      className="relative overflow-hidden"
      onPointerDown={onPointerDown}
      style={{
        gridColumn: `${rect.col} / span ${rect.w}`,
        gridRow: `${rect.row} / span ${rect.h}`,
        height: h,
        opacity: isDragging ? 0.3 : 1,
        transition: 'opacity 200ms',
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none',
      }}
    >
      {children}

      {/* Resize handle — bottom-right corner, large touch target */}
      {!isDragging && (
        <div
          data-no-drag
          className="absolute bottom-0 right-0 cursor-nwse-resize z-10 group/resize"
          style={{ width: 28, height: 28 }}
          onPointerDown={onResizePointerDown}
        >
          <svg viewBox="0 0 16 16" className="absolute bottom-1 right-1 w-4 h-4 text-white/20 group-hover/resize:text-white/50 transition-colors">
            <line x1="4" y1="14" x2="14" y2="4" stroke="currentColor" strokeWidth="1.5" />
            <line x1="8" y1="14" x2="14" y2="8" stroke="currentColor" strokeWidth="1.5" />
            <line x1="12" y1="14" x2="14" y2="12" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      )}
    </div>
  )
}
