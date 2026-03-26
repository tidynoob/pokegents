import { useState, useEffect, useRef } from 'react'
import { POKEMON_SPRITES } from './sprites'

interface SpritePickerProps {
  currentSprite: string
  onSelect: (sprite: string) => void
  onClose: () => void
}

export function SpritePicker({ currentSprite, onSelect, onClose }: SpritePickerProps) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filtered = search
    ? POKEMON_SPRITES.filter(s => s.includes(search.toLowerCase()))
    : [...POKEMON_SPRITES]

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-surface-1 border border-zinc-800 rounded-xl p-4 w-[360px] max-h-[420px] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search pokemon..."
          className="w-full bg-surface-2 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-600 mb-3"
        />
        <div className="flex-1 overflow-auto grid grid-cols-6 gap-1">
          {filtered.map(sprite => (
            <button
              key={sprite}
              onClick={() => { onSelect(sprite); onClose() }}
              className={`p-1 rounded-lg hover:bg-surface-2 flex items-center justify-center ${
                sprite === currentSprite ? 'bg-surface-2 ring-1 ring-accent-blue' : ''
              }`}
              title={sprite}
            >
              <img
                src={`/sprites/${sprite}.png`}
                alt={sprite}
                className="w-8 h-8 object-contain"
                style={{ imageRendering: 'pixelated' }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
