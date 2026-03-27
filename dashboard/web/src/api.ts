import { AgentState, SearchResponse, SearchResult, AgentMessage, AgentConnection } from './types'

const BASE = '/api'

export async function fetchSessions(): Promise<AgentState[]> {
  const res = await fetch(`${BASE}/sessions`)
  if (!res.ok) return []
  return res.json()
}

export async function search(query: string, limit = 20, offset = 0): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) })
  const res = await fetch(`${BASE}/search?${params}`)
  if (!res.ok) return { results: [], total: 0 }
  return res.json()
}

export async function fetchRecentSessions(limit = 20): Promise<SearchResult[]> {
  const res = await fetch(`${BASE}/search/recent?limit=${limit}`)
  if (!res.ok) return []
  return res.json()
}

export async function resumeSession(sessionId: string): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/resume`, { method: 'POST' })
}

export async function focusAgent(sessionId: string): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/focus`, { method: 'POST' })
}

export async function renameAgent(sessionId: string, name: string): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export async function setSprite(sessionId: string, sprite: string): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/sprite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sprite }),
  })
}

export async function fetchSpriteOverrides(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/sprite-overrides`)
  if (!res.ok) return {}
  return res.json()
}

export async function sendPrompt(sessionId: string, prompt: string): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
}

export async function checkAgentMessages(sessionId: string): Promise<void> {
  // This triggers the agent to check messages by sending a prompt
  await fetch(`${BASE}/sessions/${sessionId}/check-messages`, { method: 'POST' })
}

export async function spawnClone(sessionId: string): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/clone`, { method: 'POST' })
}

export async function shutdownAgent(sessionId: string): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/shutdown`, { method: 'POST' })
}

export async function sendMessage(from: string, to: string, content: string): Promise<AgentMessage | null> {
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, content }),
  })
  if (!res.ok) return null
  return res.json()
}

export async function fetchConnections(): Promise<AgentConnection[]> {
  const res = await fetch(`${BASE}/messages/connections`)
  if (!res.ok) return []
  return res.json()
}

export interface ActivityEntry {
  timestamp: string
  session_id: string
  agent_name: string
  files: string
  summary: string
}

export async function fetchActivity(limit = 50): Promise<ActivityEntry[]> {
  const res = await fetch(`${BASE}/activity?limit=${limit}`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchAgentOrder(): Promise<string[]> {
  const res = await fetch(`${BASE}/agent-order`)
  if (!res.ok) return []
  return res.json()
}

export async function saveAgentOrder(order: string[]): Promise<void> {
  await fetch(`${BASE}/agent-order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  })
}

export interface TranscriptEntry {
  uuid: string
  type: 'user' | 'assistant' | 'tool_result' | 'system'
  timestamp: string
  content?: string
  blocks?: { type: string; text?: string; name?: string; input?: string }[]
  tool_use_id?: string
  truncated?: boolean
  full_size?: number
  model?: string
  tokens?: { input: number; output: number; cache_read?: number; cache_create?: number }
}

export interface TranscriptPage {
  entries: TranscriptEntry[] | null
  has_more: boolean
}

export async function fetchTranscript(sessionId: string, tail = 100, after?: string): Promise<TranscriptPage> {
  const params = new URLSearchParams({ tail: String(tail) })
  if (after) params.set('after', after)
  const res = await fetch(`${BASE}/sessions/${sessionId}/transcript?${params}`)
  if (!res.ok) return { entries: null, has_more: false }
  return res.json()
}

export async function uploadImage(sessionId: string, imageBlob: Blob): Promise<{ image_num: number; path: string; ref: string } | null> {
  const form = new FormData()
  form.append('image', imageBlob, 'paste.png')
  const res = await fetch(`${BASE}/sessions/${sessionId}/image`, { method: 'POST', body: form })
  if (!res.ok) return null
  return res.json()
}

export async function fetchMessageHistory(): Promise<AgentMessage[]> {
  const res = await fetch(`${BASE}/messages`)
  if (!res.ok) return []
  return res.json()
}

export interface ProfileInfo {
  name: string
  title: string
  emoji: string
  color: [number, number, number]
}

export async function fetchProfiles(): Promise<ProfileInfo[]> {
  const res = await fetch(`${BASE}/profiles`)
  if (!res.ok) return []
  return res.json()
}

export async function launchProfile(name: string): Promise<void> {
  await fetch(`${BASE}/profiles/${name}/launch`, { method: 'POST' })
}
