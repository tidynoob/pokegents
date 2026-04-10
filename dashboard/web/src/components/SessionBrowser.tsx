import { useState, useEffect, useCallback, useRef } from 'react'
import { SearchResult } from '../types'
import { search, fetchRecentSessions, fetchSessionPreview } from '../api'

interface SessionBrowserProps {
  onClose: () => void
  activeSessionIds?: Set<string>
  onResume?: (sessionId: string) => void
}

const GRID_COLS = 6
const GRID_ROWS = 5
const PER_BOX = GRID_COLS * GRID_ROWS

// Fire Red PC Box palette
const GRASS_LIGHT  = '#90c870'
const GRASS_DARK   = '#78b058'
const PANEL_BG     = '#a8d8f0'
const PANEL_DARK   = '#6098c0'
const PANEL_BORDER = '#3878b0'
const HDR_TOP      = '#6898e0'
const HDR_BTM      = '#3868c0'
const FRAME_OUTER  = '#1838a0'
const FRAME_SHINE  = '#6090e8'
const CELL_HOVER   = 'rgba(80,148,240,0.55)'
const CELL_SEL     = 'rgba(56,120,240,0.75)'

export function SessionBrowser({ onClose, activeSessionIds, onResume }: SessionBrowserProps) {
  const [allResults, setAllResults]           = useState<SearchResult[]>([])
  const [filteredResults, setFilteredResults] = useState<SearchResult[]>([])
  const [query, setQuery]                     = useState('')
  const [loading, setLoading]                 = useState(false)
  const [selectedId, setSelectedId]           = useState<string | null>(null)
  const [revivingId, setRevivingId]           = useState<string | null>(null)
  const [reviveResult, setReviveResult]       = useState<'ok' | 'fail' | null>(null)
  const [revivedIds, setRevivedIds]           = useState<Set<string>>(new Set())
  const [boxPage, setBoxPage]                 = useState(0)
  const [searchOpen, setSearchOpen]           = useState(false)
  const [preview, setPreview]                 = useState<{ user_prompt: string; last_summary: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const filterActive = (r: SearchResult[]) =>
    activeSessionIds ? r.filter(s => !activeSessionIds.has(s.session_id)) : r

  useEffect(() => {
    fetchRecentSessions(50).then((r) => {
      const filtered = filterActive(r)
      setAllResults(filtered)
      setFilteredResults(filtered)
      if (filtered.length > 0) setSelectedId(filtered[0].session_id)
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); setQuery(''); setFilteredResults(allResults) }
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, searchOpen, allResults])

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  // Fetch preview (last prompt + last message) when selection changes
  useEffect(() => {
    if (!selectedId) { setPreview(null); return }
    let cancelled = false
    setPreview(null)
    fetchSessionPreview(selectedId).then(p => { if (!cancelled) setPreview(p) })
    return () => { cancelled = true }
  }, [selectedId])

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q)
    if (!q.trim()) {
      setFilteredResults(allResults.filter(r => !revivedIds.has(r.session_id)))
      return
    }
    setLoading(true)
    try {
      const resp = await search(q, 50)
      setFilteredResults(filterActive(resp.results || []).filter(r => !revivedIds.has(r.session_id)))
    } catch { setFilteredResults([]) }
    setLoading(false)
  }, [allResults, revivedIds])

  const handleResume = async (sessionId: string, compact?: 'yes' | 'no') => {
    setRevivingId(sessionId)
    setReviveResult(null)
    try {
      const params = compact ? `?compact=${compact}` : ''
      const res = await fetch(`/api/sessions/${sessionId}/resume${params}`, { method: 'POST' })
      if (res.ok) {
        setReviveResult('ok')
        onResume?.(sessionId)
        setTimeout(() => {
          setRevivedIds(prev => new Set([...prev, sessionId]))
          setFilteredResults(prev => prev.filter(r => r.session_id !== sessionId))
          setAllResults(prev => prev.filter(r => r.session_id !== sessionId))
          setRevivingId(null)
          setReviveResult(null)
          const remaining = filteredResults.filter(r => r.session_id !== sessionId)
          setSelectedId(remaining[0]?.session_id ?? null)
        }, 1500)
      } else {
        setReviveResult('fail')
        setTimeout(() => { setRevivingId(null); setReviveResult(null) }, 2000)
      }
    } catch {
      setReviveResult('fail')
      setTimeout(() => { setRevivingId(null); setReviveResult(null) }, 2000)
    }
  }

  const displayList = filteredResults
  const boxCount  = Math.max(1, Math.ceil(displayList.length / PER_BOX))
  const safePage  = Math.min(boxPage, boxCount - 1)
  const boxSlots  = Array.from({ length: PER_BOX }, (_, i) => displayList[safePage * PER_BOX + i] ?? null)
  const selected  = displayList.find(r => r.session_id === selectedId) ?? displayList[0] ?? null

  const getSprite = (r: SearchResult) =>
    r.sprite || r.sprite_override || POKEMON_SPRITES[hashString(r.session_id) % POKEMON_SPRITES.length]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.88)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* ── Outer GBA frame ── */}
      <div style={{
        width: 'min(820px, 96vw)',
        background: FRAME_OUTER,
        borderRadius: 10,
        padding: 3,
        boxShadow: `0 0 0 2px ${FRAME_SHINE}, 0 0 0 4px ${FRAME_OUTER}, 0 12px 48px rgba(0,0,0,0.9)`,
        userSelect: 'none',
        position: 'relative',
      }}>
        {/* ── X close button top-right ── */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: -14,
            right: -14,
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(180deg, #e05050 0%, #a02828 100%)',
            border: `2px solid ${FRAME_SHINE}`,
            boxShadow: '0 2px 0 #601010, 0 3px 8px rgba(0,0,0,0.5)',
            color: '#fff',
            fontFamily: '"Press Start 2P"',
            fontSize: 8,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
            textShadow: '1px 1px 0 rgba(0,0,0,0.5)',
          }}
        >✕</button>

        {/* ── PARTY POKÉMON tab strip ── */}
        <div style={{
          background: `linear-gradient(180deg, #5888e0 0%, #3060c0 100%)`,
          borderRadius: '7px 7px 0 0',
          padding: '5px 16px',
          marginBottom: 3,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `2px solid ${FRAME_SHINE}`,
          borderBottom: 'none',
        }}>
          <span style={{ fontFamily: '"Press Start 2P"', fontSize: 8, color: '#fff', textShadow: '1px 1px 0 #1030a0', letterSpacing: 1 }}>
            PARTY POKéMON
          </span>
        </div>

        {/* ── Main body ── */}
        <div style={{
          background: `linear-gradient(180deg, #2050b8 0%, #1840a0 100%)`,
          borderRadius: '0 0 8px 8px',
          border: `2px solid ${FRAME_SHINE}`,
          display: 'flex',
          overflow: 'hidden',
          minHeight: 440,
        }}>

          {/* ── LEFT: PKMN DATA panel ── */}
          <div style={{
            width: 220,
            flexShrink: 0,
            background: PANEL_BG,
            borderRight: `3px solid ${PANEL_BORDER}`,
            display: 'flex',
            flexDirection: 'column',
          }}>
            {/* Panel header */}
            <div style={{
              background: `linear-gradient(180deg, ${PANEL_DARK} 0%, #4888b8 100%)`,
              padding: '7px 12px',
              borderBottom: `2px solid ${PANEL_BORDER}`,
            }}>
              <span style={{ fontFamily: '"Press Start 2P"', fontSize: 9, color: '#e8f4ff', textShadow: '1px 1px 0 #1050a0', letterSpacing: 1 }}>
                PKMn DATA
              </span>
            </div>

            {selected ? (
              <PkmnDataPanel
                session={selected}
                sprite={getSprite(selected)}
                preview={preview}
                revivingId={revivingId}
                reviveResult={reviveResult}
                onResume={handleResume}
              />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: '"Press Start 2P"', fontSize: 7, color: PANEL_DARK, opacity: 0.5 }}>NO DATA</span>
              </div>
            )}
          </div>

          {/* ── RIGHT: Box grid ── */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>

            {/* Box navigation header */}
            <div style={{
              background: `linear-gradient(180deg, ${HDR_TOP} 0%, ${HDR_BTM} 100%)`,
              borderBottom: `3px solid #2050a8`,
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              {/* Search toggle */}
              <button
                onClick={() => { setSearchOpen(v => !v); if (searchOpen) { setQuery(''); setFilteredResults(allResults) } }}
                title="Search sessions"
                style={{
                  background: searchOpen ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)',
                  border: '2px solid rgba(255,255,255,0.35)',
                  borderRadius: 5,
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}
              >🔍</button>

              {searchOpen ? (
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={e => handleSearch(e.target.value)}
                  placeholder="SEARCH..."
                  style={{
                    flex: 1,
                    background: 'rgba(0,0,20,0.5)',
                    border: '2px solid rgba(255,255,255,0.35)',
                    borderRadius: 4,
                    padding: '4px 10px',
                    color: '#fff',
                    fontFamily: '"Press Start 2P"',
                    fontSize: 8,
                    outline: 'none',
                    letterSpacing: 1,
                  }}
                />
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
                  {/* Left arrow — bigger hit area */}
                  <button
                    onClick={() => { setBoxPage(p => Math.max(0, p - 1)); setSelectedId(null) }}
                    disabled={safePage === 0}
                    style={{
                      background: safePage === 0 ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.3)',
                      border: `2px solid ${safePage === 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.4)'}`,
                      borderRadius: 6,
                      padding: '6px 14px',
                      cursor: safePage === 0 ? 'default' : 'pointer',
                      color: safePage === 0 ? 'rgba(255,255,255,0.2)' : '#fff',
                      fontFamily: '"Press Start 2P"',
                      fontSize: 12,
                      textShadow: '1px 1px 0 rgba(0,0,0,0.6)',
                      lineHeight: 1,
                      transition: 'all 0.1s',
                    }}
                  >◄</button>

                  {/* Box name — larger */}
                  <span style={{
                    fontFamily: '"Press Start 2P"',
                    fontSize: 14,
                    color: '#fff',
                    textShadow: '2px 2px 0 rgba(0,0,0,0.5), -1px -1px 0 rgba(255,255,255,0.15)',
                    letterSpacing: 3,
                    minWidth: 90,
                    textAlign: 'center',
                  }}>
                    BOX {safePage + 1}
                  </span>

                  {/* Right arrow */}
                  <button
                    onClick={() => { setBoxPage(p => Math.min(boxCount - 1, p + 1)); setSelectedId(null) }}
                    disabled={safePage >= boxCount - 1}
                    style={{
                      background: safePage >= boxCount - 1 ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.3)',
                      border: `2px solid ${safePage >= boxCount - 1 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.4)'}`,
                      borderRadius: 6,
                      padding: '6px 14px',
                      cursor: safePage >= boxCount - 1 ? 'default' : 'pointer',
                      color: safePage >= boxCount - 1 ? 'rgba(255,255,255,0.2)' : '#fff',
                      fontFamily: '"Press Start 2P"',
                      fontSize: 12,
                      textShadow: '1px 1px 0 rgba(0,0,0,0.6)',
                      lineHeight: 1,
                      transition: 'all 0.1s',
                    }}
                  >►</button>
                </div>
              )}

              {loading && <span style={{ fontFamily: '"Press Start 2P"', fontSize: 6, color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>...</span>}
            </div>

            {/* ── Grass grid ── */}
            <div style={{
              flex: 1,
              padding: '10px 12px',
              backgroundImage: `repeating-conic-gradient(${GRASS_LIGHT} 0% 25%, ${GRASS_DARK} 0% 50%)`,
              backgroundSize: '14px 14px',
              display: 'grid',
              gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
              gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
              gap: 4,
            }}>
              {boxSlots.map((session, i) => (
                <GridCell
                  key={i}
                  session={session}
                  sprite={session ? getSprite(session) : null}
                  isSelected={session?.session_id === selected?.session_id}
                  onClick={() => session && setSelectedId(session.session_id)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Grid cell ────────────────────────────────────────────
function GridCell({ session, sprite, isSelected, onClick }: {
  session: SearchResult | null
  sprite: string | null
  isSelected: boolean
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => session && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        aspectRatio: '1',
        borderRadius: 4,
        cursor: session ? 'pointer' : 'default',
        background: isSelected ? CELL_SEL : hovered && session ? CELL_HOVER : 'rgba(0,0,0,0.12)',
        border: isSelected
          ? '2px solid rgba(140,200,255,0.9)'
          : hovered && session
            ? '2px solid rgba(100,170,255,0.6)'
            : '2px solid rgba(0,0,0,0.15)',
        boxShadow: isSelected ? 'inset 0 0 0 1px rgba(255,255,255,0.3)' : 'inset 0 1px 0 rgba(255,255,255,0.08)',
        transition: 'background 0.08s, border-color 0.08s',
        overflow: 'hidden',
      }}
    >
      {sprite && (
        <img
          src={`/sprites/${sprite}.png`}
          alt=""
          draggable={false}
          style={{
            imageRendering: 'pixelated',
            transform: 'scale(2)',
            filter: 'drop-shadow(1px 2px 0 rgba(0,0,0,0.35))',
          }}
        />
      )}
    </div>
  )
}

// ── PKMN DATA left panel ────────────────────────────────
function PkmnDataPanel({ session, sprite, preview, revivingId, reviveResult, onResume }: {
  session: SearchResult
  sprite: string
  preview: { user_prompt: string; last_summary: string } | null
  revivingId: string | null
  reviveResult: 'ok' | 'fail' | null
  onResume: (id: string, compact?: 'yes' | 'no') => void
}) {
  const isReviving = revivingId === session.session_id
  const name = session.custom_title || session.session_id.slice(0, 8)
  const [r, g, b] = session.project_color || [100, 100, 100]

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '10px 10px', gap: 7, overflow: 'hidden' }}>

      {/* Sprite display */}
      <div style={{
        background: `linear-gradient(135deg, #c8e8f8 0%, #a8d0e8 100%)`,
        border: `2px solid ${PANEL_BORDER}`,
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.4) 1px, transparent 1px)',
        backgroundSize: '6px 6px',
        flexShrink: 0,
      }}>
        <img
          src={`/sprites/${sprite}.png`}
          alt={name}
          style={{ imageRendering: 'pixelated', width: 72, height: 72, objectFit: 'contain', filter: 'drop-shadow(2px 3px 0 rgba(0,0,0,0.25))' }}
        />
      </div>

      {/* Name plate */}
      <div style={{
        background: 'rgba(255,255,255,0.45)',
        border: `1px solid ${PANEL_BORDER}`,
        borderRadius: 4,
        padding: '4px 8px',
        textAlign: 'center',
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: '"Press Start 2P"', fontSize: 7,
          color: '#1848a0',
          textShadow: '1px 1px 0 rgba(255,255,255,0.5)',
          letterSpacing: 0.5,
          wordBreak: 'break-all',
          display: 'block', lineHeight: 1.6,
        }}>
          {name.toUpperCase().slice(0, 16)}
        </span>
      </div>

      {/* Role + Project pills — matching AgentCard styling exactly */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flexShrink: 0 }}>
        {session.role && (
          <span
            className="text-[6px] font-pixel text-white rounded-sm px-1.5 py-px pixel-shadow shrink-0 uppercase"
            style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.2)' }}
          >
            {session.role_emoji ? `${session.role_emoji} ${session.role}` : session.role}
          </span>
        )}
        {(session.project || session.profile_name) && (
          <span
            className="text-[6px] font-pixel text-white rounded-sm px-1.5 py-px pixel-shadow shrink-0 uppercase"
            style={{
              background: `rgba(${r}, ${g}, ${b}, 0.6)`,
              border: `1px solid rgba(${r}, ${g}, ${b}, 0.8)`,
            }}
          >
            {session.project || session.profile_name}
          </span>
        )}
        {session.task_group && (
          <span
            className="text-[6px] font-pixel text-white/80 rounded-sm px-1.5 py-px pixel-shadow shrink-0 uppercase"
            style={{
              background: 'rgba(120, 80, 200, 0.5)',
              border: '1px solid rgba(120, 80, 200, 0.7)',
            }}
          >
            {session.task_group}
          </span>
        )}
      </div>

      {/* LAST PROMPT box */}
      <InfoBox label="LAST PROMPT" text={preview?.user_prompt || session.snippet} />

      {/* LAST MESSAGE box */}
      <InfoBox label="LAST MESSAGE" text={preview?.last_summary} />

      {/* RESUME buttons */}
      {isReviving ? (
        <div
          style={{
            width: '100%',
            padding: '8px 0',
            borderRadius: 5,
            border: reviveResult === 'ok' ? '2px solid #58d068'
              : reviveResult === 'fail' ? '2px solid #e05040'
              : '2px solid #d0a830',
            background: reviveResult === 'ok' ? 'linear-gradient(180deg, #58d068 0%, #38a848 100%)'
              : reviveResult === 'fail' ? 'linear-gradient(180deg, #e05040 0%, #b03020 100%)'
              : 'linear-gradient(180deg, #d0a830 0%, #a07820 100%)',
            fontFamily: '"Press Start 2P"',
            fontSize: 8,
            color: '#fff',
            textShadow: '1px 1px 0 rgba(0,0,0,0.5)',
            letterSpacing: 1,
            textAlign: 'center',
            transform: 'translateY(2px)',
            flexShrink: 0,
          }}
        >
          {reviveResult === 'ok' ? '✓ REVIVED!' : reviveResult === 'fail' ? '✗ FAILED' : '▶▶ REVIVING...'}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => onResume(session.session_id)}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 5,
              border: '2px solid #6090e0',
              background: 'linear-gradient(180deg, #5888e0 0%, #3060c0 100%)',
              boxShadow: '0 3px 0 #1838a0, 0 4px 6px rgba(0,0,0,0.3)',
              cursor: 'pointer',
              fontFamily: '"Press Start 2P"',
              fontSize: 7,
              color: '#fff',
              textShadow: '1px 1px 0 rgba(0,0,0,0.5)',
              letterSpacing: 1,
              transition: 'all 0.1s',
            }}
          >
            ▶ RESUME
          </button>
          <button
            onClick={() => onResume(session.session_id, 'yes')}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 5,
              border: '2px solid #d09030',
              background: 'linear-gradient(180deg, #d09030 0%, #a06820 100%)',
              boxShadow: '0 3px 0 #704010, 0 4px 6px rgba(0,0,0,0.3)',
              cursor: 'pointer',
              fontFamily: '"Press Start 2P"',
              fontSize: 7,
              color: '#fff',
              textShadow: '1px 1px 0 rgba(0,0,0,0.5)',
              letterSpacing: 1,
              transition: 'all 0.1s',
            }}
          >
            ▶ COMPACT
          </button>
        </div>
      )}
    </div>
  )
}

// ── Shared info box (LAST PROMPT / LAST MESSAGE) ─────────
function InfoBox({ label, text }: { label: string; text?: string }) {
  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      background: 'rgba(255,255,255,0.35)',
      border: `1px solid ${PANEL_BORDER}`,
      borderRadius: 4,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{
        background: `rgba(${PANEL_DARK.replace('#','').match(/../g)!.map(h=>parseInt(h,16)).join(',')},0.5)`,
        padding: '2px 6px',
        borderBottom: `1px solid ${PANEL_BORDER}`,
        flexShrink: 0,
      }}>
        <span style={{ fontFamily: '"Press Start 2P"', fontSize: 5, color: '#e8f4ff', letterSpacing: 0.5 }}>
          {label}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 6px' }}>
        {text ? (
          <p style={{
            fontFamily: 'monospace', fontSize: 9,
            color: '#204880', lineHeight: 1.5,
            wordBreak: 'break-word', whiteSpace: 'pre-wrap', margin: 0,
          }}
            dangerouslySetInnerHTML={{ __html: text }}
          />
        ) : (
          <span style={{ fontFamily: '"Press Start 2P"', fontSize: 5, color: '#6098c0', opacity: 0.5 }}>—</span>
        )}
      </div>
    </div>
  )
}
