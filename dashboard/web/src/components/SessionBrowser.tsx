import { useState, useEffect, useCallback } from 'react'
import { SearchResult } from '../types'
import { search, fetchRecentSessions, resumeSession } from '../api'
import { POKEMON_SPRITES } from './sprites'
import { hashString } from './CreatureIcon'

interface SessionBrowserProps {
  onClose: () => void
  activeSessionIds?: Set<string>
}

export function SessionBrowser({ onClose, activeSessionIds }: SessionBrowserProps) {
  const [results, setResults] = useState<SearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)

  const filterActive = (r: SearchResult[]) =>
    activeSessionIds ? r.filter(s => !activeSessionIds.has(s.session_id)) : r

  useEffect(() => {
    fetchRecentSessions(50).then((r) => {
      const filtered = filterActive(r)
      setResults(filtered)
      setTotal(filtered.length)
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q)
    if (!q.trim()) {
      const recent = await fetchRecentSessions(50)
      const filtered = filterActive(recent)
      setResults(filtered)
      setTotal(filtered.length)
      return
    }
    setLoading(true)
    try {
      const resp = await search(q, 50)
      const filtered = filterActive(resp.results || [])
      setResults(filtered)
      setTotal(filtered.length)
    } catch {
      setResults([])
    }
    setLoading(false)
  }, [])

  const [revivedIds, setRevivedIds] = useState<Set<string>>(new Set())
  const [revivingId, setRevivingId] = useState<string | null>(null)
  const [reviveResult, setReviveResult] = useState<'ok' | 'fail' | null>(null)
  const handleResume = async (sessionId: string) => {
    setRevivingId(sessionId)
    setReviveResult(null)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' })
      if (res.ok) {
        setReviveResult('ok')
        setTimeout(() => {
          setRevivedIds(prev => new Set([...prev, sessionId]))
          setRevivingId(null)
          setReviveResult(null)
        }, 3000)
      } else {
        setReviveResult('fail')
      }
    } catch {
      setReviveResult('fail')
    }
  }

  return (
    <div className="fixed inset-0 bg-surface-0/95 z-50 overflow-auto">
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[10px] font-pixel text-white pixel-shadow">PC BOX</h2>
          <button
            onClick={onClose}
            className="gba-button text-[7px] font-pixel px-3 py-1.5"
          >
            CANCEL
          </button>
        </div>

        {/* Search input */}
        <div className="mb-4">
          <div className="gba-dialog rounded-lg">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); handleSearch(e.target.value) }}
              placeholder="Search POKeMON..."
              className="w-full bg-transparent px-4 py-2.5 text-sm font-mono text-gba-dialog-border placeholder:text-gba-dialog-border/30 outline-none"
            />
          </div>
        </div>

        <p className="text-[7px] font-pixel text-white/40 mb-3 pixel-shadow">
          {loading ? 'Searching...' : `${total} found`}
        </p>

        {/* Results */}
        <div className="flex flex-col gap-1.5">
          {results.filter(r => !revivedIds.has(r.session_id)).map((r) => {
            const sprite = r.sprite_override || POKEMON_SPRITES[hashString(r.session_id) % POKEMON_SPRITES.length]
            return (
              <div
                key={r.session_id}
                className="flex items-center justify-between gap-3 gba-card px-4 py-3 transition-colors hover:brightness-110"
              >
                <img
                  src={`/sprites/${sprite}.png`}
                  alt=""
                  className="w-8 h-8 shrink-0"
                  style={{ imageRendering: 'pixelated' }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[9px] font-pixel text-white truncate pixel-shadow">
                      {r.custom_title || r.session_id.slice(0, 8)}
                    </span>
                    {r.role && r.project ? (
                      <>
                        <span className="text-[6px] font-pixel text-white/80 bg-black/30 rounded-sm px-1.5 py-px pixel-shadow uppercase" style={{ border: '1px solid rgba(255,255,255,0.15)' }}>{r.role_emoji ? `${r.role_emoji} ${r.role}` : r.role}</span>
                        <span className="text-[6px] font-pixel text-white rounded-sm px-1.5 py-px pixel-shadow uppercase" style={{ background: r.project_color ? `rgba(${r.project_color[0]}, ${r.project_color[1]}, ${r.project_color[2]}, 0.6)` : 'rgba(100,100,100,0.6)', border: r.project_color ? `1px solid rgba(${r.project_color[0]}, ${r.project_color[1]}, ${r.project_color[2]}, 0.8)` : '1px solid rgba(100,100,100,0.8)' }}>{r.project}</span>
                      </>
                    ) : r.profile_name ? (
                      <span className="text-[7px] font-pixel text-white/40 pixel-shadow">{r.profile_name}</span>
                    ) : null}
                  </div>
                  {r.snippet && (
                    <div
                      className="text-xs font-mono text-white/50 truncate [&_mark]:bg-accent-yellow/30 [&_mark]:text-accent-yellow [&_mark]:rounded-sm [&_mark]:px-0.5"
                      dangerouslySetInnerHTML={{ __html: r.snippet }}
                    />
                  )}
                </div>
                <button
                  onClick={() => handleResume(r.session_id)}
                  disabled={revivingId === r.session_id}
                  className={`shrink-0 text-[7px] font-pixel px-3 py-1.5 ${
                    revivingId === r.session_id
                      ? reviveResult === 'ok' ? 'bg-accent-green text-white rounded-full'
                        : reviveResult === 'fail' ? 'bg-accent-red text-white rounded-full'
                        : 'gba-card-selected'
                      : 'gba-button'
                  }`}
                  style={revivingId === r.session_id && reviveResult ? { boxShadow: 'inset 1px 1px 0 rgba(255,255,255,0.2), inset -1px -1px 0 rgba(0,0,0,0.2)' } : undefined}
                >
                  {revivingId === r.session_id
                    ? reviveResult === 'ok' ? 'ACTIVE!'
                      : reviveResult === 'fail' ? 'FAIL'
                      : 'REVIVING...'
                    : 'REVIVE'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
