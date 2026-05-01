import { useMemo } from 'react'

// Derives common boolean/computed state from an agent's raw fields.
// Centralises busy/idle/error derivation and capability checks so
// AgentCard, ChatPanel, and App don't duplicate the same logic.
export function useAgentState(agent: {
  state?: string
  busy_since?: string
  interface?: string
  background_tasks?: number
}) {
  return useMemo(() => {
    const isBusy = agent.state === 'busy'
    const isError = agent.state === 'error'
    const isIdle = agent.state === 'idle' || (!isBusy && !isError)

    const busySince = agent.busy_since ? new Date(agent.busy_since) : null
    const recentlyFinished =
      !isBusy && busySince && Date.now() - busySince.getTime() < 60_000

    return {
      isBusy,
      isError,
      isIdle,
      recentlyFinished,
      busySince,
      hasStreamingUI: agent.interface === 'chat',
      backgroundTasks: agent.background_tasks ?? 0,
    }
  }, [agent.state, agent.busy_since, agent.interface, agent.background_tasks])
}
