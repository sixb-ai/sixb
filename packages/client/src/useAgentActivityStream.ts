import { useEffect, useRef, useState } from "react"
import { type AgentRunActivityEvent, createAgentActivitySocket } from "./agent-streams"
import type { ReconnectingSocketState } from "./ws-socket"

export interface UseAgentActivityStreamOptions {
  readonly enabled?: boolean
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  readonly onActivity?: (event: AgentRunActivityEvent) => void
  readonly onSubscribed?: () => void
  readonly onError?: (message: string) => void
}

export type UseAgentActivityStreamResult = ReconnectingSocketState

const DISCONNECTED: ReconnectingSocketState = { connected: false, reconnecting: false, error: null }

/** React binding for the single project-level Agent lifecycle subscription. */
export function useAgentActivityStream(
  options: UseAgentActivityStreamOptions
): UseAgentActivityStreamResult {
  const { enabled = true, reconnect, reconnectDelayMs } = options
  const onActivityRef = useRef(options.onActivity)
  onActivityRef.current = options.onActivity
  const onSubscribedRef = useRef(options.onSubscribed)
  onSubscribedRef.current = options.onSubscribed
  const onErrorRef = useRef(options.onError)
  onErrorRef.current = options.onError
  const [state, setState] = useState<ReconnectingSocketState>(DISCONNECTED)

  useEffect(() => {
    if (!enabled) {
      setState(DISCONNECTED)
      return
    }
    const socket = createAgentActivitySocket({
      reconnect,
      reconnectDelayMs,
      onActivity: (event) => onActivityRef.current?.(event),
      onSubscribed: () => onSubscribedRef.current?.(),
      onError: (message) => onErrorRef.current?.(message),
      onStateChange: setState,
    })
    return () => socket.close()
  }, [enabled, reconnect, reconnectDelayMs])

  return state
}
