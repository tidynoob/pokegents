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

  const handleResume = async (sessionId: string) => {
    await resumeSession(sessionId)
  }

  return (
    <div className="fixed inset-0 bg-surface-0/95 backdrop-blur-sm z-50 overflow-auto">
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-zinc-100">Previous sessions</h2>
          <button
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 rounded border border-zinc-800 hover:border-zinc-700 transition-colors"
          >
            ESC
          </button>
        </div>

        {/* Search input */}
        <div className="mb-4">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); handleSearch(e.target.value) }}
            placeholder="Search conversations..."
            className="w-full bg-surface-1 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-600 transition-colors"
          />
        </div>

        <p className="text-xs text-zinc-600 mb-3">
          {loading ? 'Searching...' : `${total} session${total !== 1 ? 's' : ''}`}
        </p>

        {/* Results */}
        <div className="flex flex-col gap-1.5">
          {results.map((r) => {
            const sprite = r.sprite_override || POKEMON_SPRITES[hashString(r.session_id) % POKEMON_SPRITES.length]
            return (
              <div
                key={r.session_id}
                className="flex items-center justify-between gap-3 bg-surface-1 hover:bg-surface-2 border border-zinc-800/50 rounded-lg px-4 py-3 transition-colors"
              >
                <img
                  src={`/sprites/${sprite}.png`}
                  alt=""
                  className="w-8 h-8 shrink-0"
                  style={{ imageRendering: 'pixelated' }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm text-zinc-200 truncate">
                      {r.custom_title || r.session_id.slice(0, 8)}
                    </span>
                    {r.profile_name && (
                      <span className="text-xs text-zinc-600">{r.profile_name}</span>
                    )}
                  </div>
                  {r.snippet && (
                    <div
                      className="text-xs text-zinc-500 truncate [&_mark]:bg-accent-yellow/20 [&_mark]:text-accent-yellow [&_mark]:rounded-sm [&_mark]:px-0.5"
                      dangerouslySetInnerHTML={{ __html: r.snippet }}
                    />
                  )}
                </div>
                <button
                  onClick={() => handleResume(r.session_id)}
                  className="shrink-0 text-xs text-accent-blue hover:text-blue-300 px-2.5 py-1.5 rounded border border-zinc-800 hover:border-accent-blue/30 transition-colors"
                >
                  Resume
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
