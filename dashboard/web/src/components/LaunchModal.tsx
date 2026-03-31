import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ProjectInfo, RoleInfo, launchProfile, sendMessage, setSprite, renameAgent, fetchSessions } from '../api'
import { AgentState } from '../types'
import { POKEMON_SPRITES } from './sprites'
import { SpritePicker } from './SpritePicker'

interface LaunchModalProps {
  projects: ProjectInfo[]
  roles: RoleInfo[]
  agents: AgentState[]
  onClose: () => void
}

function GbaDropdown<T extends { key: string; label: string; color?: [number, number, number]; sprite?: string }>({ label, value, options, onChange, allowNone }: {
  label: string
  value: string
  options: T[]
  onChange: (key: string) => void
  allowNone?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const selected = options.find(o => o.key === value)

  return (
    <div ref={ref} className="relative">
      <label className="text-[7px] font-pixel text-white/50 pixel-shadow block mb-1.5">{label}</label>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gba-panel px-3 py-2 text-[10px] font-mono text-white/90 hover:brightness-110 transition-colors"
      >
        <span className="flex items-center gap-2">
          {selected?.sprite && (
            <img src={`/sprites/${selected.sprite}.png`} alt="" className="w-4 h-4" style={{ imageRendering: 'pixelated' }} />
          )}
          {selected?.color && (
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: `rgb(${selected.color[0]},${selected.color[1]},${selected.color[2]})` }} />
          )}
          {selected ? selected.label : 'None'}
        </span>
        <span className="text-white/30 text-[8px]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 gba-panel z-50 py-1 max-h-[200px] overflow-y-auto">
          {allowNone !== false && (
            <button
              onClick={() => { onChange(''); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[10px] font-mono hover:bg-white/10 transition-colors ${!value ? 'text-accent-yellow' : 'text-white/50'}`}
            >
              None
            </button>
          )}
          {options.map(o => (
            <button
              key={o.key}
              onClick={() => { onChange(o.key); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[10px] font-mono hover:bg-white/10 transition-colors flex items-center gap-2 ${value === o.key ? 'text-accent-yellow' : 'text-white/90'}`}
            >
              {o.sprite && (
                <img src={`/sprites/${o.sprite}.png`} alt="" className="w-4 h-4" style={{ imageRendering: 'pixelated' }} />
              )}
              {o.color && (
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: `rgb(${o.color[0]},${o.color[1]},${o.color[2]})` }} />
              )}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function LaunchModal({ projects, roles, agents, onClose }: LaunchModalProps) {
  const [selectedParent, setSelectedParent] = useState('')
  const [selectedRole, setSelectedRole] = useState('')
  const [selectedProject, setSelectedProject] = useState('')
  const [name, setName] = useState('')
  const [sprite, setSelectedSprite] = useState('')
  const [showSpritePicker, setShowSpritePicker] = useState(false)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // When parent changes, pre-select their role and project
  const handleParentChange = (parentId: string) => {
    setSelectedParent(parentId)
    if (parentId) {
      const parent = agents.find(a => a.session_id === parentId)
      if (parent) {
        if (parent.role && roles.some(r => r.name === parent.role)) setSelectedRole(parent.role)
        if (parent.project && projects.some(p => p.name === parent.project)) setSelectedProject(parent.project)
      }
    }
  }

  const canLaunch = selectedProject || selectedRole

  const roleOptions = roles.map(r => ({ key: r.name, label: r.title }))
  const projectOptions = projects.map(p => ({ key: p.name, label: p.title, color: p.color }))
  const agentOptions = agents.map(a => ({
    key: a.session_id,
    label: a.display_name || a.profile_name,
  }))

  const [randomSprite] = useState(() => POKEMON_SPRITES[Math.floor(Math.random() * POKEMON_SPRITES.length)])
  const displaySprite = sprite || randomSprite

  const handleLaunch = async () => {
    if (!canLaunch || launching) return
    setLaunching(true)

    // Snapshot current agent IDs so we can detect the new one
    const existingIds = new Set(agents.map(a => a.session_id))

    let profile = ''
    if (selectedRole && selectedProject) {
      profile = `${selectedRole}@${selectedProject}`
    } else if (selectedProject) {
      profile = `@${selectedProject}`
    } else if (selectedRole) {
      profile = `${selectedRole}@`
    }

    await launchProfile(profile)

    // Poll for the new agent, wait for session ID to stabilize, then set sprite + name
    const wantSprite = sprite
    const wantName = name.trim()
    if (wantSprite || wantName) {
      let lastSeenId = ''
      let stableCount = 0
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500))
        const fresh = await fetchSessions()
        const newAgent = fresh.find(a => !existingIds.has(a.session_id))
        if (newAgent) {
          // Wait for session_id to stabilize (hook reconciliation may change it)
          if (newAgent.session_id === lastSeenId) {
            stableCount++
          } else {
            lastSeenId = newAgent.session_id
            stableCount = 0
          }
          // Stable for 2 polls (1s) — safe to set
          if (stableCount >= 2) {
            if (wantSprite) await setSprite(newAgent.session_id, wantSprite)
            if (wantName) await renameAgent(newAgent.session_id, wantName)
            break
          }
        }
      }
    }

    if (selectedParent) {
      const roleName = roles.find(r => r.name === selectedRole)?.title || selectedRole
      const projectName = projects.find(p => p.name === selectedProject)?.title || selectedProject
      const agentName = name || [roleName, projectName].filter(Boolean).join(' @ ')
      const desc = [roleName, projectName].filter(Boolean).join(' @ ')
      await sendMessage(
        'dashboard',
        selectedParent,
        `New agent "${agentName}" spawned reporting to you (${desc}). They've been instructed to follow your direction.`
      )
    }

    setLaunching(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="gba-panel p-5 w-[340px] flex flex-col gap-3"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[9px] font-pixel text-white pixel-shadow">NEW AGENT</h3>
          <button onClick={onClose} className="gba-button text-[6px] font-pixel px-2 py-1">CANCEL</button>
        </div>

        {/* Name & Pokemon */}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-[7px] font-pixel text-white/50 pixel-shadow block mb-1.5">NAME</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Auto-generated"
              className="w-full gba-panel px-3 py-2 text-[10px] font-mono text-white/90 placeholder:text-white/30 outline-none"
            />
          </div>
          <div>
            <label className="text-[7px] font-pixel text-white/50 pixel-shadow block mb-1.5">SPRITE</label>
            <button
              onClick={() => setShowSpritePicker(true)}
              className="gba-panel px-2 py-1 hover:brightness-110 transition-colors flex items-center gap-1.5"
            >
              <img
                src={`/sprites/${displaySprite}.png`}
                alt=""
                className="w-6 h-6"
                style={{ imageRendering: 'pixelated' }}
              />
              <span className="text-white/30 text-[8px]">▼</span>
            </button>
          </div>
        </div>

        {/* Reports To */}
        <GbaDropdown label="REPORTS TO" value={selectedParent} options={agentOptions} onChange={handleParentChange} />

        {/* Role & Project side by side */}
        <div className="flex gap-2">
          <div className="flex-1">
            <GbaDropdown label="ROLE" value={selectedRole} options={roleOptions} onChange={setSelectedRole} />
          </div>
          <div className="flex-1">
            <GbaDropdown label="PROJECT" value={selectedProject} options={projectOptions} onChange={setSelectedProject} />
          </div>
        </div>

        {/* Preview */}
        <div className="text-[8px] font-mono text-white/40 px-1">
          {canLaunch ? (
            <>
              pokegent {selectedRole && selectedProject
                ? `${selectedRole}@${selectedProject}`
                : selectedProject
                  ? `@${selectedProject}`
                  : `${selectedRole}@`
              }
              {selectedParent && (
                <span className="text-white/25"> → {agents.find(a => a.session_id === selectedParent)?.display_name}</span>
              )}
            </>
          ) : (
            <span className="text-white/20">Select a role or project</span>
          )}
        </div>

        <button
          onClick={handleLaunch}
          disabled={!canLaunch || launching}
          className={`w-full gba-button text-[8px] font-pixel px-3 py-2.5 transition-colors ${
            !canLaunch ? 'opacity-30 cursor-not-allowed' : ''
          }`}
        >
          {launching ? 'LAUNCHING...' : 'GO!'}
        </button>
      </div>

      {showSpritePicker && createPortal(
        <SpritePicker
          currentSprite={displaySprite}
          onSelect={(s) => { setSelectedSprite(s); setShowSpritePicker(false) }}
          onClose={() => setShowSpritePicker(false)}
        />,
        document.body
      )}
    </div>
  )
}
