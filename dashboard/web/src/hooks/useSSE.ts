import { useEffect, useRef, useState, useCallback } from 'react'
import { AgentState, AgentConnection, AgentMessage } from '../types'

function agentsEqual(a: AgentState[], b: AgentState[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].session_id !== b[i].session_id ||
        a[i].state !== b[i].state ||
        a[i].detail !== b[i].detail ||
        a[i].last_trace !== b[i].last_trace ||
        a[i].last_summary !== b[i].last_summary ||
        a[i].user_prompt !== b[i].user_prompt ||
        a[i].display_name !== b[i].display_name ||
        a[i].sprite !== b[i].sprite ||
        a[i].task_group !== b[i].task_group ||
        a[i].role !== b[i].role ||
        a[i].project !== b[i].project ||
        a[i].busy_since !== b[i].busy_since ||
        a[i].context_tokens !== b[i].context_tokens ||
        (a[i].recent_actions?.length || 0) !== (b[i].recent_actions?.length || 0) ||
        (a[i].activity_feed?.length || 0) !== (b[i].activity_feed?.length || 0)) {
      return false
    }
  }
  return true
}

export function useSSE() {
  const [agents, setAgents] = useState<AgentState[]>([])
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [newMessage, setNewMessage] = useState<AgentMessage | null>(null)
  const [connected, setConnected] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
    }

    const es = new EventSource('/api/events')
    esRef.current = es

    es.onopen = () => setConnected(true)

    es.addEventListener('state_update', (e) => {
      try {
        const data = JSON.parse(e.data) as AgentState[]
        setAgents(prev => agentsEqual(prev, data) ? prev : data)
      } catch { /* ignore */ }
    })

    es.addEventListener('connections_update', (e) => {
      try {
        setConnections(JSON.parse(e.data) as AgentConnection[])
      } catch { /* ignore */ }
    })

    es.addEventListener('new_message', (e) => {
      try {
        setNewMessage(JSON.parse(e.data) as AgentMessage)
      } catch { /* ignore */ }
    })

    es.onerror = () => {
      setConnected(false)
      es.close()
      reconnectTimeout.current = setTimeout(connect, 3000)
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current)
    }
  }, [connect])

  return { agents, connections, newMessage, connected }
}
