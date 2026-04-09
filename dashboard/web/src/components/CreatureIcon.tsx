import { useState } from 'react'
import { createPortal } from 'react-dom'
import { SpritePicker } from './SpritePicker'
import { setSprite } from '../api'

export function hashString(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

interface CreatureIconProps {
  sessionId: string
  size?: number
  noGlow?: boolean
  doneFlash?: boolean
  spriteOverride?: string
  editable?: boolean
  noBg?: boolean
}

export function CreatureIcon({ sessionId, size = 40, noGlow, doneFlash, spriteOverride, editable, noBg }: CreatureIconProps) {
  const sprite = spriteOverride || 'pokeball'
  const [showPicker, setShowPicker] = useState(false)

  const handleSelect = async (newSprite: string) => {
    await setSprite(sessionId, newSprite)
  }

  return (
    <>
      <div
        className={`shrink-0 flex items-center justify-center overflow-visible ${!noGlow && !noBg ? 'bg-black/20 rounded-lg' : ''} ${editable ? 'cursor-pointer hover:brightness-125' : ''}`}
        style={{ width: size, height: size }}
        onClick={editable ? (e) => { e.stopPropagation(); setShowPicker(true) } : undefined}
      >
        <img
          className="creature-sprite"
          src={`/sprites/${sprite}.png`}
          alt={sprite}
          style={{
            imageRendering: 'pixelated',
            ...(noGlow ? {} : { transform: 'scale(1.3)' }),
          }}
        />
      </div>
      {showPicker && createPortal(
        <SpritePicker
          currentSprite={sprite}
          onSelect={handleSelect}
          onClose={() => setShowPicker(false)}
        />,
        document.body
      )}
    </>
  )
}
