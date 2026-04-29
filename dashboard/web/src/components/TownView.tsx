import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentState, stableId } from '../types'
import { useSpriteAnimation } from './spriteAnimations'

// ── Grid geometry ──────────────────────────────────────────
// Source town.png is 768×640. We crop it to the playable inner town (drops
// the left mountains, top/right/bottom tree borders) so sprites are easier
// to read at small zoom.
const CELL = 16
const SOURCE_W = 768
const SOURCE_H = 640

// Hand-tuned crop of town.png. Drops the left mountains, top trees, right
// tree column, and bottom tree row, leaving the playable inner town centered.
const CROP_LEFT = 96
const CROP_TOP = 48
const CROP_RIGHT = 688
const CROP_BOTTOM = 512
const COLS = (CROP_RIGHT - CROP_LEFT) / CELL  // 37
const ROWS = (CROP_BOTTOM - CROP_TOP) / CELL  // 29
const MAP_W = COLS * CELL  // 592
const MAP_H = ROWS * CELL  // 464

// Pokémon sprites render at this fixed pixel size, regardless of CELL. The
// sprite intentionally overflows its parent cell button; alignment is done by
// absolute-positioning + marginLeft so the cell's small width doesn't squish
// the image (which a flexbox parent would do).
const SPRITE_PX = 36

// Default mask: everything walkable. The crop already removes the
// trees/mountains border, so within the visible playable area the user paints
// obstacles (buildings, pond) and zones with the brush toolbar in debug mode.
const TOWN_MASK: readonly string[] = Array.from({ length: ROWS }, () => '.'.repeat(COLS))

// Module-level mutable copy of the mask. Hydrated from `/api/town-mask` on
// mount (if a saved version exists) and mutated in place when the user paints
// in debug mode. Pathfinding/spawn helpers read from this rather than the
// constant so paints take effect immediately without threading state through
// every setInterval closure.
let mutableMask: string[] = [...TOWN_MASK]

// Walkable = anything that isn't a wall. Path/busy-station/idle-area cells
// all let sprites pass through; only `#` blocks. (Earlier this was strict
// `=== '.'` which broke BFS the moment the user painted any cell with a
// station or idle tag.)
function walkable(col: number, row: number): boolean {
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false
  const line = mutableMask[row]
  if (!line) return false
  return line[col] !== '#'
}

// ── Cell-type vocabulary ───────────────────────────────────
//   '#' — blocked (not walkable)
//   '.' — walkable (default)
//   '1' '2' '3' — busy station 1/2/3 (busy agents path here; task_group is
//                  hashed to one of the active stations)
//   'i' — idle area (idle agents wander only within these cells, if any exist)
// All non-'#' chars are walkable. Stations and idle area are *also* walkable —
// the char just tags the cell with extra semantics.

export type Brush = 'walkable' | 'block' | 'busy1' | 'busy2' | 'busy3' | 'idle'

export const BRUSH_CHARS: Record<Brush, string> = {
  walkable: '.', block: '#',
  busy1: '1', busy2: '2', busy3: '3',
  idle: 'i',
}

const BRUSH_COLORS: Record<Brush, string> = {
  // Walkable bumped from 25% → 40% so the grid stands out clearly against
  // the green grass backdrop (25% blended in too much).
  walkable: 'rgba(80,220,120,0.40)',
  block:    'rgba(255,60,60,0.55)',
  busy1:    'rgba(80,140,255,0.60)',
  busy2:    'rgba(180,80,255,0.60)',
  busy3:    'rgba(255,160,40,0.60)',
  idle:     'rgba(255,220,80,0.60)',
}

const BRUSH_LABELS: Record<Brush, string> = {
  walkable: 'PATH', block: 'WALL',
  busy1: 'BUSY 1', busy2: 'BUSY 2', busy3: 'BUSY 3',
  idle: 'IDLE',
}

function cellChar(col: number, row: number): string {
  const line = mutableMask[row]
  if (!line) return '#'
  return line[col] || '#'
}

function colorForChar(ch: string): string {
  switch (ch) {
    case '#': return BRUSH_COLORS.block
    case '1': return BRUSH_COLORS.busy1
    case '2': return BRUSH_COLORS.busy2
    case '3': return BRUSH_COLORS.busy3
    case 'i': return BRUSH_COLORS.idle
    default:  return BRUSH_COLORS.walkable
  }
}

function listCells(matchChars: Set<string>): Cell[] {
  const out: Cell[] = []
  for (let r = 0; r < ROWS; r++) {
    const line = mutableMask[r] || ''
    for (let c = 0; c < COLS; c++) {
      if (matchChars.has(line[c])) out.push({ col: c, row: r })
    }
  }
  return out
}

function stationCells(idx: number): Cell[] {
  return listCells(new Set([String(idx + 1)]))
}

function activeStationIndices(): number[] {
  const out: number[] = []
  for (let i = 0; i < 3; i++) if (stationCells(i).length > 0) out.push(i)
  return out
}

function idleAreaCells(): Cell[] {
  return listCells(new Set(['i']))
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i)
    h = h | 0
  }
  return Math.abs(h)
}

// All painted busy cells, pooled across stations 1/2/3. Default routing:
// busy agents pick any free cell from the combined pool, so when multiple
// busy agents exist they distribute across all painted stations rather than
// being hashed to a single one. (Per-task_group routing is still possible
// via stationFor below — kept for future use; not currently called.)
function allBusyCells(): Cell[] {
  return listCells(new Set(['1', '2', '3']))
}

// Pick a station group for a given task_group string. Hash-deterministic.
// Currently unused — busy routing is pooled (see allBusyCells); this stays
// in case we want per-group routing back later.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function stationFor(taskGroupOrId: string): Cell[] {
  const active = activeStationIndices()
  if (active.length === 0) return []
  const idx = active[hashString(taskGroupOrId || '') % active.length]
  return stationCells(idx)
}

function inCells(c: Cell, list: Cell[]): boolean {
  return list.some(x => x.col === c.col && x.row === c.row)
}

// Hard-coded fallback when nothing is painted — front of the Pokémon Center.
const FALLBACK_CENTER: Cell = { col: 12, row: 15 }

// ── Pathfinding (BFS on the walkable grid) ─────────────────

type Cell = { col: number; row: number }

function cellKey(c: Cell): string { return `${c.col},${c.row}` }

function neighbours(c: Cell): Cell[] {
  return [
    { col: c.col + 1, row: c.row },
    { col: c.col - 1, row: c.row },
    { col: c.col, row: c.row + 1 },
    { col: c.col, row: c.row - 1 },
  ].filter(n => walkable(n.col, n.row))
}

/** Return next cell to step toward target, or null if no path. */
function stepToward(from: Cell, to: Cell): Cell | null {
  if (from.col === to.col && from.row === to.row) return null
  const queue: Cell[] = [from]
  const parent = new Map<string, Cell>()
  parent.set(cellKey(from), from)
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.col === to.col && cur.row === to.row) {
      // Walk back via parents to find first step
      let step = cur
      while (parent.get(cellKey(step)) && cellKey(parent.get(cellKey(step))!) !== cellKey(from)) {
        step = parent.get(cellKey(step))!
      }
      return step
    }
    for (const n of neighbours(cur)) {
      if (!parent.has(cellKey(n))) {
        parent.set(cellKey(n), cur)
        queue.push(n)
      }
    }
  }
  return null
}

// Random spawn point. Prefer the painted idle area if any exist.
function randomWalkableCell(): Cell {
  const idle = idleAreaCells()
  if (idle.length > 0) return idle[Math.floor(Math.random() * idle.length)]
  for (let i = 0; i < 200; i++) {
    const c = Math.floor(Math.random() * COLS)
    const r = Math.floor(Math.random() * ROWS)
    if (walkable(c, r)) return { col: c, row: r }
  }
  return FALLBACK_CENTER
}

// ── Sprite model ───────────────────────────────────────────

interface TownSprite {
  id: string            // pokegent_id / stableId
  sprite: string
  displayName: string
  agentState: AgentState['state']  // 'idle', 'busy', etc.
  taskGroup: string     // used to deterministically assign a busy station
  pos: Cell
  target: Cell | null
  facing: 'left' | 'right'
  nextMoveAt: number
  // Duration the CSS transform-transition uses to animate the current move.
  // Tracked per-sprite so cross-zone transit (busy↔idle journeys) animates at
  // STEP_MS_TRANSIT while idle-ambling stays at STEP_MS_IDLE — without this
  // the render would fall back to a state-only ternary and visuals would
  // desync from the real step timing.
  stepMs: number
}

function isBusy(s: AgentState['state']) {
  return s === 'busy' || s === 'needs_input' || s === 'permission' || s === 'waiting'
}

// ── Component ──────────────────────────────────────────────

interface TownViewProps {
  agents: AgentState[]
  onSelect: (agent: AgentState) => void
  selectedId: string | null
  debug?: boolean
}

// Per-state step durations. Idle pokes amble (slower step + longer wander
// cooldowns); during state transitions and once at a busy station they move
// fast so the trip between zones reads as a sprint, not a saunter.
const STEP_MS_IDLE = 900       // each idle-wander step within the idle area
const STEP_MS_TRANSIT = 80     // cross-zone travel: idle→busy or busy→idle
const IDLE_COOLDOWN_MIN = 2400
const IDLE_COOLDOWN_MAX = 7000

// Movement tick rate. Must be ≤ the smallest STEP_MS we ever schedule —
// otherwise the loop becomes the floor and a sprite that "should" step every
// 80ms only steps every TICK_MS. We previously ran at 120ms which silently
// clamped transit to 8 steps/sec no matter how low STEP_MS_TRANSIT went.
const TICK_MS = 30

export function TownView({ agents, onSelect, selectedId, debug = false }: TownViewProps) {
  const [sprites, setSprites] = useState<Record<string, TownSprite>>({})
  const spritesRef = useRef(sprites)
  spritesRef.current = sprites

  // Walkable mask, fetched from server on mount.
  const [mask, setMask] = useState<string[]>(() => mutableMask)
  // Gate sprite spawning on the mask being loaded so a fresh refresh doesn't
  // scatter sprites onto cells the user has painted as walls.
  const [maskReady, setMaskReady] = useState(false)
  useEffect(() => {
    fetch('/api/town-mask')
      .then(r => (r.status === 204 ? null : r.json()))
      .then(data => {
        if (data && Array.isArray(data.mask) && data.mask.length === ROWS) {
          mutableMask = data.mask
          setMask(data.mask)
        }
      })
      .catch(() => { /* keep default */ })
      .finally(() => setMaskReady(true))
  }, [])

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistMask = (next: string[]) => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      fetch('/api/town-mask', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: COLS, rows: ROWS, mask: next }),
      }).catch(() => {})
    }, 400)
  }

  // Active brush + drag-paint plumbing. paintingRef tracks whether the mouse
  // is held; activeBrush picks which char to paint with. Default to `block`
  // so the user's first click on a default-walkable cell does something
  // visible (otherwise walkable→walkable is a no-op and the UI looks broken).
  const [activeBrush, setActiveBrush] = useState<Brush>('block')
  const paintingRef = useRef(false)
  const activeBrushRef = useRef(activeBrush)
  activeBrushRef.current = activeBrush

  // Stop painting on mouseup anywhere — robust against the user dragging out
  // of the map and releasing.
  useEffect(() => {
    if (!debug) return
    const stop = () => { paintingRef.current = false }
    document.addEventListener('mouseup', stop)
    return () => document.removeEventListener('mouseup', stop)
  }, [debug])

  const paintCell = (c: number, r: number) => {
    setMask(prev => {
      const next = [...prev]
      const line = next[r]
      if (!line || c < 0 || c >= COLS) return prev
      const ch = BRUSH_CHARS[activeBrushRef.current]
      if (line[c] === ch) return prev
      next[r] = line.substring(0, c) + ch + line.substring(c + 1)
      mutableMask = next
      persistMask(next)
      return next
    })
  }

  // Sync sprites with the agents list. Gated on `maskReady` so sprites don't
  // spawn before the saved mask loads — otherwise a refresh would scatter
  // them onto cells the user has since painted as walls.
  useEffect(() => {
    if (!maskReady) return
    setSprites(prev => {
      const next: Record<string, TownSprite> = {}
      const now = Date.now()

      for (const a of agents) {
        const id = stableId(a)
        const taskGroup = a.task_group || ''
        const existing = prev[id]
        const newState = a.state
        const wasBusy = existing ? isBusy(existing.agentState) : false
        const nowBusy = isBusy(newState)

        if (existing) {
          let target = existing.target
          // Re-target on busy/idle transition. Random pick (not [0]) so
          // multiple agents flipping busy at once spread across painted tiles
          // rather than all converging on the same first-listed cell. The
          // tick re-checks each frame, so this is just a snappy first hint.
          const stateFlipped = nowBusy !== wasBusy
          if (nowBusy && !wasBusy) {
            const busyCells = allBusyCells()
            target = busyCells.length > 0
              ? busyCells[Math.floor(Math.random() * busyCells.length)]
              : FALLBACK_CENTER
          } else if (!nowBusy && wasBusy) {
            target = randomWalkableCell()
          }
          // If existing pos is on a wall (e.g. mask just got repainted),
          // re-spawn the sprite somewhere walkable.
          let pos = existing.pos
          if (!walkable(pos.col, pos.row)) pos = randomWalkableCell()
          next[id] = {
            ...existing,
            pos,
            sprite: a.sprite || 'pokeball',
            displayName: a.display_name || a.profile_name,
            agentState: newState,
            taskGroup,
            target,
            // On state flip, cancel any pending idle cooldown so the agent
            // starts moving toward the new zone NOW. Previously a sprite
            // mid-amble could be sitting on a 7s wander cooldown when its
            // state changed — making the entire transition feel laggy even
            // though the per-step speed was fast.
            nextMoveAt: stateFlipped ? now : existing.nextMoveAt,
          }
        } else {
          const spawn = randomWalkableCell()
          const busyCells = nowBusy ? allBusyCells() : []
          // Random pick (not [0]) so freshly-spawned busy agents distribute
          // across painted busy tiles instead of all converging on the first.
          const initialBusyTarget = busyCells.length > 0
            ? busyCells[Math.floor(Math.random() * busyCells.length)]
            : FALLBACK_CENTER
          next[id] = {
            id,
            sprite: a.sprite || 'pokeball',
            displayName: a.display_name || a.profile_name,
            agentState: newState,
            taskGroup,
            pos: spawn,
            target: nowBusy ? initialBusyTarget : null,
            facing: 'right',
            nextMoveAt: now + 300 + Math.random() * 600, // stagger first moves
            stepMs: nowBusy ? STEP_MS_TRANSIT : STEP_MS_IDLE,
          }
        }
      }
      return next
    })
  }, [agents, maskReady])

  // Movement tick — every STEP_MS, advance sprites by one cell toward target.
  useEffect(() => {
    const interval = setInterval(() => {
      setSprites(prev => {
        const now = Date.now()
        const next: Record<string, TownSprite> = { ...prev }
        let changed = false

        // Pool of painted busy cells across stations 1/2/3. Busy agents pick
        // any free cell from the pool so multiple busy sprites distribute
        // instead of stacking on the first tile.
        const busyPool = allBusyCells()
        const idlePool = idleAreaCells()
        const claimedBusy = new Set<string>()

        for (const id of Object.keys(next)) {
          const s = next[id]
          const busy = isBusy(s.agentState)
          const atIdleArea = !busy && idlePool.length > 0 && inCells(s.pos, idlePool)

          if (busy) {
            const targetIsBusy = s.target ? inCells(s.target, busyPool) : false

            if (busyPool.length === 0) {
              // No busy stations painted — fall back to a fixed cell.
              s.target = FALLBACK_CENTER
            } else if (!targetIsBusy) {
              // Pick a RANDOM free busy cell so agents distribute across the
              // painted area. (Was first-found, which funneled all overflow
              // agents onto busyPool[0].)
              const free = busyPool.filter(c =>
                !claimedBusy.has(cellKey(c)) && !isOccupied(next, c, id))
              const pick = free.length > 0
                ? free[Math.floor(Math.random() * free.length)]
                : busyPool[Math.floor(Math.random() * busyPool.length)]
              s.target = pick
              claimedBusy.add(cellKey(pick))
            } else if (s.target) {
              claimedBusy.add(cellKey(s.target))
            }
          }

          // Step delay:
          //  - busy traveling toward a busy cell: sprint
          //  - idle but not yet inside the idle area: sprint home
          //  - idle inside idle area (or no idle area painted): amble
          // The two transit modes share STEP_MS_TRANSIT — both feel like a
          // dash between zones, vs the slow STEP_MS_IDLE wander.
          const stepDelay = busy || (idlePool.length > 0 && !atIdleArea)
            ? STEP_MS_TRANSIT
            : STEP_MS_IDLE

          // If at target:
          if (s.target && s.pos.col === s.target.col && s.pos.row === s.target.row) {
            if (!busy) {
              // Idle cooldown then pick a new wander target
              if (now >= s.nextMoveAt) {
                const next_ = pickIdleStep(s.pos)
                if (next_) {
                  next[id] = { ...s, target: next_, nextMoveAt: now + stepDelay, stepMs: stepDelay }
                  changed = true
                } else {
                  next[id] = { ...s, nextMoveAt: now + 800 }
                }
              }
            }
            // Busy + arrived at station: stay put (no pacing).
            continue
          }

          // If we have a target, step one cell closer (pathfinding)
          if (s.target && now >= s.nextMoveAt) {
            const step = stepToward(s.pos, s.target)
            if (step) {
              const facing: 'left' | 'right' = step.col < s.pos.col ? 'left' : step.col > s.pos.col ? 'right' : s.facing
              next[id] = {
                ...s,
                pos: step,
                facing,
                nextMoveAt: now + stepDelay,
                stepMs: stepDelay,
              }
              changed = true
            } else {
              // No path — wait and retry
              next[id] = { ...s, nextMoveAt: now + 800 }
              changed = true
            }
            continue
          }

          // No target, idle — schedule a wander
          if (!s.target && !busy && now >= s.nextMoveAt) {
            const next_ = pickIdleStep(s.pos)
            if (next_) {
              next[id] = {
                ...s,
                target: next_,
                nextMoveAt: now + randomCooldown(),
                stepMs: stepDelay,
              }
              changed = true
            }
          }
        }

        return changed ? next : prev
      })
    }, TICK_MS)
    return () => clearInterval(interval)
  }, [])

  // Compute scale so the map fits the container width while preserving aspect.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const measure = () => {
      const parent = wrapRef.current?.parentElement
      if (!parent) return
      const w = parent.clientWidth
      const h = parent.clientHeight
      if (w < 10 || h < 10) return
      // Leave 16px padding so the box-shadow border doesn't get clipped by parent overflow.
      const PAD = 16
      const s = Math.min((w - PAD) / MAP_W, (h - PAD) / MAP_H, 1) // never upscale past 1x
      setScale(s > 0 ? s : 1)
    }
    // Two rAFs so flexbox has time to settle before first measure
    requestAnimationFrame(() => requestAnimationFrame(measure))
    const ro = new ResizeObserver(measure)
    const parent = wrapRef.current?.parentElement
    if (parent) ro.observe(parent)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  const spriteList = useMemo(() => Object.values(sprites), [sprites])

  return (
    <div
      ref={wrapRef}
      className="relative flex items-center justify-center overflow-hidden"
      style={{
        width: MAP_W * scale,
        height: MAP_H * scale,
        maxWidth: '100%',
        maxHeight: '100%',
        // Tiny frame around the map image itself — the inner box-shadow used to
        // do this but got clipped by overflow-hidden. Border lives on the outer
        // wrapper now so it actually renders.
        border: '3px solid #1a4838',
        boxShadow: '0 0 0 1px #0b2418, 0 4px 14px rgba(0,0,0,0.45)',
        borderRadius: 4,
      }}
    >
      {debug && (
        <div
          data-no-drag
          style={{
            position: 'absolute',
            top: 6, left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
            display: 'flex',
            gap: 4,
            background: 'rgba(0,0,0,0.78)',
            padding: '4px 6px',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.15)',
            fontFamily: 'monospace',
            fontSize: 9,
            userSelect: 'none',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(['walkable','block','busy1','busy2','busy3','idle'] as Brush[]).map(b => {
            const active = activeBrush === b
            return (
              <button
                key={b}
                onClick={(e) => { e.stopPropagation(); setActiveBrush(b) }}
                title={`Paint as ${BRUSH_LABELS[b]} (${BRUSH_CHARS[b]})`}
                style={{
                  padding: '3px 6px',
                  border: active ? '1px solid #ffde4f' : '1px solid rgba(255,255,255,0.15)',
                  background: active ? BRUSH_COLORS[b] : 'transparent',
                  color: active ? '#fff' : 'rgba(255,255,255,0.65)',
                  fontFamily: 'monospace',
                  fontSize: 9,
                  cursor: 'pointer',
                  borderRadius: 2,
                  letterSpacing: 0.5,
                }}
              >
                {BRUSH_LABELS[b]}
              </button>
            )
          })}
        </div>
      )}
      <div
        style={{
          width: MAP_W,
          height: MAP_H,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          position: 'absolute',
          imageRendering: 'pixelated',
          // background-image with negative position is the most robust way to
          // render a cropped sub-region of an image — naturally clipped to
          // element bounds, no img/overflow shenanigans.
          backgroundImage: `url(/town.png)`,
          backgroundPosition: `-${CROP_LEFT}px -${CROP_TOP}px`,
          backgroundSize: `${SOURCE_W}px ${SOURCE_H}px`,
          backgroundRepeat: 'no-repeat',
          overflow: 'hidden',
        }}
      >

        {/* Debug overlay: cell-type mask. Cells are drag-paintable with the
            currently selected brush; colors mirror the brush palette so what
            you paint is what shows.
            data-no-drag stops the parent grid cell from interpreting the drag
            as a card move (GridCell scans closest('[data-no-drag]')). */}
        {debug && mask && (
          <div data-no-drag style={{ position: 'absolute', inset: 0 }}>
            {Array.from({ length: ROWS }).map((_, r) =>
              Array.from({ length: COLS }).map((__, c) => {
                const ch = cellChar(c, r)
                return (
                  <div
                    key={`dbg-${c}-${r}`}
                    onMouseDown={(e) => {
                      e.stopPropagation(); e.preventDefault()
                      paintingRef.current = true
                      paintCell(c, r)
                    }}
                    onMouseEnter={() => {
                      if (paintingRef.current) paintCell(c, r)
                    }}
                    title={`(${c},${r}) [${ch}] — drag to paint with ${BRUSH_LABELS[activeBrush]}`}
                    style={{
                      position: 'absolute',
                      left: c * CELL,
                      top: r * CELL,
                      width: CELL,
                      height: CELL,
                      background: colorForChar(ch),
                      border: '1px solid rgba(0,0,0,0.18)',
                      boxSizing: 'border-box',
                      fontFamily: 'monospace',
                      fontSize: 9,
                      color: 'rgba(0,0,0,0.7)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'crosshair',
                      pointerEvents: 'auto',
                      userSelect: 'none',
                    }}
                  >
                    {ch === '.' || ch === '#' ? '' : ch.toUpperCase()}
                  </div>
                )
              })
            )}
          </div>
        )}

        {/* Sprites */}
        {spriteList.map(s => {
          const px = s.pos.col * CELL
          const py = s.pos.row * CELL
          const selected = selectedId === s.id
          return (
            <button
              key={s.id}
              onClick={(e) => { e.stopPropagation(); spriteClick(agents, s.id, onSelect) }}
              title={s.displayName}
              className="group"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: CELL,
                height: CELL,
                transform: `translate(${px}px, ${py}px)`,
                transition: `transform ${s.stepMs ?? (isBusy(s.agentState) ? STEP_MS_TRANSIT : STEP_MS_IDLE)}ms linear`,
                cursor: 'pointer',
                zIndex: Math.floor(py),
                padding: 0,
                border: 0,
                background: 'transparent',
              }}
            >
              {/* Selection ring */}
              {selected && (
                <div
                  style={{
                    position: 'absolute',
                    inset: -2,
                    borderRadius: '50%',
                    boxShadow: '0 0 0 2px #ffde4f, 0 0 12px rgba(255,222,79,0.6)',
                    pointerEvents: 'none',
                  }}
                />
              )}
              {/* State badge — anchored to the sprite's top-right area */}
              {isBusy(s.agentState) && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: SPRITE_PX - 4,
                    left: '50%',
                    marginLeft: SPRITE_PX / 2 - 12,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: '#ff5050',
                    boxShadow: '0 0 0 1.5px #301010, 0 0 6px rgba(255,80,80,0.7)',
                    animation: 'pulse 1.2s infinite',
                    zIndex: 1,
                  }}
                />
              )}
              {/* Sprite — absolute-positioned and centered on the cell so the
                  parent's small width (CELL=16) doesn't squish it. The img is
                  intentionally larger than the cell and overflows visibly.
                  Wrapper carries the per-state animation class (sprite-hop,
                  sprite-bump-*, etc.) reused from the agent-card system; the
                  inner img keeps its facing flip + aspect-preserving fit.
                  `stationary` gates the animation cycle: when the sprite is
                  walking between cells the bump-left/bump-right animations
                  conflict with the parent translate and read as the sprite
                  reversing direction. So we only animate at-rest, matching
                  the card preview where the sprite never moves. */}
              <TownSpritePoke
                sprite={s.sprite}
                state={s.agentState}
                facing={s.facing}
                stationary={!s.target || (s.pos.col === s.target.col && s.pos.row === s.target.row)}
              />
            </button>
          )
        })}

      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.6; transform: scale(0.85); }
        }
      `}</style>
    </div>
  )
}

// Per-sprite animator. Pulled into its own component so each sprite owns its
// own useSpriteAnimation cycle (the hook holds setTimeout state — sharing it
// would mean every sprite hops on the same beat). Reuses the same animation
// registry as the agent-card preview, so card-busy and town-busy match.
function TownSpritePoke({ sprite, state, facing, stationary }: {
  sprite: string
  state: AgentState['state']
  facing: 'left' | 'right'
  stationary: boolean
}) {
  // active=false makes the hook hold the defaultClass (gentle sprite-idle bob)
  // instead of cycling through busy hop/bump/shake. We only want the cycle
  // when the sprite has arrived at its target — during transit the wrapper's
  // animation transforms fight the parent translate.
  const animClass = useSpriteAnimation(state, stationary)
  return (
    <div
      className={animClass}
      style={{
        position: 'absolute',
        bottom: 0,
        left: '50%',
        marginLeft: -SPRITE_PX / 2,
        width: SPRITE_PX,
        height: SPRITE_PX,
        pointerEvents: 'none',
      }}
    >
      <img
        src={`/sprites/${sprite}.png`}
        alt=""
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          // Tailwind preflight sets img { max-width: 100% } — leave that
          // alone here since the wrapper already pins us to SPRITE_PX.
          // Sprites have varied native aspect ratios (kakuna is 13×18,
          // pikachu 21×20). `contain` preserves aspect so narrow sprites
          // don't stretch into squares; `bottom` keeps feet grounded.
          objectFit: 'contain',
          objectPosition: 'bottom',
          imageRendering: 'pixelated',
          filter: 'drop-shadow(1px 2px 0 rgba(0,0,0,0.45))',
          userSelect: 'none',
          // Facing flip lives on the img so the wrapper's animation class
          // (which sets transform: translate/rotate) doesn't fight it.
          // Source sprite art faces LEFT, so we mirror when the agent is
          // moving right. Inverting this reads as walking backward.
          transform: facing === 'right' ? 'scaleX(-1)' : undefined,
        }}
      />
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────

// Idle wander step. If an idle area is painted, prefer staying inside it —
// when already inside, pick a random idle-area neighbor; when outside, pick
// the next step toward a random idle-area cell. With no idle area defined we
// fall back to wandering anywhere walkable.
function pickIdleStep(from: Cell): Cell | null {
  const idle = idleAreaCells()
  if (idle.length > 0) {
    const insideIdle = neighbours(from).filter(n => inCells(n, idle))
    if (insideIdle.length > 0) {
      return insideIdle[Math.floor(Math.random() * insideIdle.length)]
    }
    const target = idle[Math.floor(Math.random() * idle.length)]
    return stepToward(from, target)
  }
  const ns = neighbours(from)
  if (ns.length === 0) return null
  return ns[Math.floor(Math.random() * ns.length)]
}

function randomCooldown(): number {
  return IDLE_COOLDOWN_MIN + Math.random() * (IDLE_COOLDOWN_MAX - IDLE_COOLDOWN_MIN)
}

function isOccupied(sprites: Record<string, TownSprite>, cell: Cell, selfId: string): boolean {
  for (const id in sprites) {
    if (id === selfId) continue
    const s = sprites[id]
    if ((s.target?.col === cell.col && s.target?.row === cell.row) ||
        (s.pos.col === cell.col && s.pos.row === cell.row)) return true
  }
  return false
}

function spriteClick(agents: AgentState[], id: string, onSelect: (a: AgentState) => void) {
  const a = agents.find(x => stableId(x) === id)
  if (a) onSelect(a)
}
