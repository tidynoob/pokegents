import { useEffect, useRef, useState } from 'react'
import { AgentState } from '../types'
import {
  focusAgent, checkAgentMessages, spawnClone, shutdownAgent,
  assignRole, assignProject, assignTaskGroup, migrateInterface,
  RuntimeCapabilities, ProjectInfo, RoleInfo,
} from '../api'

// AgentMenu is the right-click / overflow menu for an agent. Used by both
// AgentCard (right-click on the grid cell) and ChatPanel (header overflow
// button). All actions are runtime-aware: the menu hides items the
// runtime advertises it can't support (e.g. "Go to terminal" for chat,
// "Spawn clone" for chat). Everything else — rename, sprite, role, project,
// task-group, switch-interface, release — works for any runtime.

interface AgentMenuProps {
  x: number
  y: number
  agent: AgentState
  capabilities: RuntimeCapabilities
  onClose: () => void
  onRename: () => void
  onChangeSprite: () => void
  onCollapse?: () => void
  onAssignStatus?: (msg: string) => void
  projects?: ProjectInfo[]
  roles?: RoleInfo[]
  existingGroups?: string[]
}

export function AgentMenu({
  x, y, agent, capabilities, onClose, onRename, onChangeSprite, onCollapse,
  projects, roles, existingGroups, onAssignStatus,
}: AgentMenuProps) {
  const [submenu, setSubmenu] = useState<'role' | 'project' | 'group' | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const newGroupRef = useRef<HTMLInputElement>(null)

  const showStatus = (res: { status: string }, label: string) => {
    if (!onAssignStatus) return
    if (res.status === 'relaunching') onAssignStatus(`Relaunching as ${label}...`)
    else if (res.status === 'queued') onAssignStatus(`Queued — ${label} on idle`)
    else if (res.status === 'updated') onAssignStatus(`Set ${label}`)
  }

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (submenu) setSubmenu(null); else onClose() }
    }
    document.addEventListener('keydown', keyHandler)
    return () => document.removeEventListener('keydown', keyHandler)
  }, [onClose, submenu])

  const menuWidth = 200
  const subMenuWidth = 150
  const flipSub = x + menuWidth + subMenuWidth > window.innerWidth
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: flipSub ? Math.max(0, x - menuWidth) : Math.min(x, window.innerWidth - menuWidth),
    top: Math.min(y, window.innerHeight - 300),
    zIndex: 10000,
  }
  const subPos = flipSub ? 'right-full mr-1' : 'left-full ml-1'

  // Top-level items, capability-gated. The order matches the legacy
  // AgentCard menu so muscle memory carries.
  type MenuItem = { label: string; icon: string; action: () => void }
  const items: MenuItem[] = []
  if (capabilities.can_focus) {
    items.push({ label: 'Go to terminal', icon: '⌨', action: () => { focusAgent(agent.session_id); onClose() } })
  }
  items.push({ label: 'Check messages', icon: '💬', action: () => { checkAgentMessages(agent.session_id); onClose() } })
  items.push({ label: 'Rename', icon: '✏️', action: onRename })
  items.push({ label: 'Change pokemon', icon: '🔄', action: onChangeSprite })
  if (capabilities.can_clone) {
    items.push({ label: 'Spawn clone', icon: '🧬', action: () => { spawnClone(agent.session_id); onClose() } })
  }
  if (onCollapse) {
    items.push({ label: 'Collapse', icon: '📌', action: () => { onCollapse(); onClose() } })
  }

  return (
    <>
      <div
        className="fixed inset-0"
        style={{ zIndex: 9999 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div style={menuStyle}>
        <div className="gba-panel py-1 min-w-[190px]">
        {items.map((item) => (
          <button
            key={item.label}
            onClick={(e) => { e.stopPropagation(); item.action() }}
            className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-white/90 hover:bg-white/10 hover:text-white flex items-center gap-2 transition-colors pixel-shadow"
          >
            <span className="w-4 text-center">{item.icon}</span>
            {item.label}
          </button>
        ))}

        {/* Role/Project assignment */}
        {(roles && roles.length > 0 || projects && projects.length > 0) && (
          <>
            <div className="border-t border-white/10 my-1" />
            {roles && roles.length > 0 && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setSubmenu(submenu === 'role' ? null : 'role') }}
                  className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-white/90 hover:bg-white/10 hover:text-white flex items-center gap-2 transition-colors pixel-shadow"
                >
                  <span className="w-4 text-center">🎭</span>
                  {agent.role ? `Role: ${agent.role}` : 'Assign role'}
                  <span className="ml-auto text-white/30">▸</span>
                </button>
                {submenu === 'role' && (
                  <div className={`absolute top-0 ${subPos} gba-panel py-1 min-w-[140px]`}>
                    {agent.role && (
                      <button
                        onClick={async (e) => { e.stopPropagation(); const res = await assignRole(agent.session_id, ''); showStatus(res, 'no role'); onClose() }}
                        className="w-full text-left px-3 py-1.5 text-[7px] font-pixel text-white/40 hover:bg-white/10 transition-colors pixel-shadow italic"
                      >
                        None
                      </button>
                    )}
                    {roles.map(r => (
                      <button
                        key={r.name}
                        onClick={async (e) => { e.stopPropagation(); const res = await assignRole(agent.session_id, r.name); showStatus(res, r.title); onClose() }}
                        className={`w-full text-left px-3 py-1.5 text-[7px] font-pixel hover:bg-white/10 transition-colors pixel-shadow flex items-center gap-1.5 ${agent.role === r.name ? 'text-accent-yellow' : 'text-white/90'}`}
                      >
                        <span>{r.emoji}</span>
                        <span>{r.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {projects && projects.length > 0 && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setSubmenu(submenu === 'project' ? null : 'project') }}
                  className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-white/90 hover:bg-white/10 hover:text-white flex items-center gap-2 transition-colors pixel-shadow"
                >
                  <span className="w-4 text-center">📁</span>
                  {agent.project ? `Project: ${agent.project}` : 'Assign project'}
                  <span className="ml-auto text-white/30">▸</span>
                </button>
                {submenu === 'project' && (
                  <div className={`absolute top-0 ${subPos} gba-panel py-1 min-w-[140px]`}>
                    {agent.project && (
                      <button
                        onClick={async (e) => { e.stopPropagation(); const res = await assignProject(agent.session_id, ''); showStatus(res, 'no project'); onClose() }}
                        className="w-full text-left px-3 py-1.5 text-[7px] font-pixel text-white/40 hover:bg-white/10 transition-colors pixel-shadow italic"
                      >
                        None
                      </button>
                    )}
                    {projects.map(p => (
                      <button
                        key={p.name}
                        onClick={async (e) => { e.stopPropagation(); const res = await assignProject(agent.session_id, p.name); showStatus(res, p.title); onClose() }}
                        className={`w-full text-left px-3 py-1.5 text-[7px] font-pixel hover:bg-white/10 transition-colors pixel-shadow flex items-center gap-1.5 ${agent.project === p.name ? 'text-accent-yellow' : 'text-white/90'}`}
                      >
                        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: `rgb(${p.color[0]},${p.color[1]},${p.color[2]})` }} />
                        <span>{p.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Group assignment */}
        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setSubmenu(submenu === 'group' ? null : 'group') }}
            className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-white/90 hover:bg-white/10 hover:text-white flex items-center gap-2 transition-colors pixel-shadow"
          >
            <span className="w-4 text-center">📦</span>
            {agent.task_group ? `Group: ${agent.task_group}` : 'Assign group'}
            <span className="ml-auto text-white/30">▸</span>
          </button>
          {submenu === 'group' && (
            <div className={`absolute top-0 ${subPos} gba-panel py-1 min-w-[140px]`}>
              {agent.task_group && (
                <button
                  onClick={async (e) => { e.stopPropagation(); await assignTaskGroup(agent.session_id, ''); onAssignStatus?.('Removed from group'); onClose() }}
                  className="w-full text-left px-3 py-1.5 text-[7px] font-pixel text-white/40 hover:bg-white/10 transition-colors pixel-shadow italic"
                >
                  None
                </button>
              )}
              {(existingGroups || []).map(g => (
                <button
                  key={g}
                  onClick={async (e) => { e.stopPropagation(); await assignTaskGroup(agent.session_id, g); onAssignStatus?.(`Group: ${g}`); onClose() }}
                  className={`w-full text-left px-3 py-1.5 text-[7px] font-pixel hover:bg-white/10 transition-colors pixel-shadow ${agent.task_group === g ? 'text-accent-yellow' : 'text-white/90'}`}
                >
                  {g}
                </button>
              ))}
              <div className="border-t border-white/10 my-1" />
              <form
                className="px-2 py-1 flex gap-1"
                onClick={(e) => e.stopPropagation()}
                onSubmit={async (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const name = newGroupName.trim()
                  if (!name) return
                  await assignTaskGroup(agent.session_id, name)
                  onAssignStatus?.(`Group: ${name}`)
                  onClose()
                }}
              >
                <input
                  ref={newGroupRef}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="New group..."
                  className="flex-1 bg-black/30 border border-white/20 rounded px-1.5 py-0.5 text-[7px] font-pixel text-white outline-none focus:border-white/40"
                  style={{ minWidth: 0 }}
                  autoFocus
                />
                <button
                  type="submit"
                  className="text-[7px] font-pixel text-white/60 hover:text-white px-1"
                >+</button>
              </form>
            </div>
          )}
        </div>

        <div className="border-t border-white/10 my-1" />
        {/* Switch interface — preserves identity + Claude session_id, swaps the runtime. */}
        <button
          onClick={async (e) => {
            e.stopPropagation()
            const target = agent.interface === 'chat' ? 'iterm2' : 'chat'
            try {
              const result = await migrateInterface(agent.session_id, target)
              if (target === 'chat') {
                window.dispatchEvent(new CustomEvent('open-chat-panel', {
                  detail: { pokegentId: result.pokegent_id },
                }))
              }
            } catch (err) {
              alert(`Switch failed: ${err instanceof Error ? err.message : String(err)}`)
            }
            onClose()
          }}
          className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-white hover:bg-white/10 flex items-center gap-2 transition-colors pixel-shadow"
          title="Same conversation, same identity — different runtime"
        >
          <span className="w-4 text-center">⇄</span>
          {agent.interface === 'chat' ? 'Switch to iTerm2' : 'Switch to Chat'}
        </button>
        <div className="border-t border-white/10 my-1" />
        <button
          onClick={(e) => { e.stopPropagation(); shutdownAgent(agent.session_id); onClose() }}
          className="w-full text-left px-3 py-1.5 text-[8px] font-pixel text-accent-red hover:bg-white/10 flex items-center gap-2 transition-colors pixel-shadow"
        >
          <span className="w-4 text-center">⏻</span>
          Release
        </button>
        </div>
      </div>
    </>
  )
}
