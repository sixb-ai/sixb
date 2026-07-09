/**
 * React hook over the `logs` builder (`@sixb/client/hooks`).
 *
 * `useSixbLogs(logs.workflows().run(id))` loads retained history through the
 * builder's `.read()` terminal, then live-tails new lines through `.subscribe()`
 * from the last history cursor, accumulating into a capped buffer. It mirrors
 * `useEvents`: the builder is read through a ref so handler/identity churn never
 * tears the socket down, and the subscription rebuilds only when the filter IR
 * (or a load option) changes. `react` is an optional peer, so this hook lives
 * behind the `./hooks` subpath and never the root barrel.
 */
import { useEffect, useRef, useState } from "react"
import type { LogsBuilder } from "./logs-builder"
import type { SixbLogLine } from "./logs-model"
import type { LogSocketState } from "./logs-transport"

const DISCONNECTED: LogSocketState = { connected: false, reconnecting: false, error: null }

export interface UseSixbLogsOptions {
  readonly enabled?: boolean
  /** Retained lines to load before tailing (default 200). */
  readonly history?: number
  /** Cap on accumulated lines; the oldest are dropped past it (default 1000). */
  readonly max?: number
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  readonly onError?: (error: string) => void
}

export interface UseSixbLogsResult {
  readonly lines: SixbLogLine[]
  readonly connected: boolean
  readonly error: string | null
}

export function useSixbLogs(builder: LogsBuilder, options?: UseSixbLogsOptions): UseSixbLogsResult {
  const builderRef = useRef(builder)
  builderRef.current = builder
  const onErrorRef = useRef(options?.onError)
  onErrorRef.current = options?.onError

  const [lines, setLines] = useState<SixbLogLine[]>([])
  const [state, setState] = useState<LogSocketState>(DISCONNECTED)

  const enabled = options?.enabled ?? true
  const history = options?.history ?? 200
  const max = options?.max ?? 1000
  const reconnect = options?.reconnect
  const reconnectDelayMs = options?.reconnectDelayMs
  const irKey = JSON.stringify(builder.ir)

  // Rebuild only when the serialized filter IR (or a load option) changes; the
  // builder and error handler are read through refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: irKey is the reactive proxy for builder.ir, read via builderRef
  useEffect(() => {
    if (!enabled) {
      setLines([])
      setState(DISCONNECTED)
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    const builderNow = builderRef.current
    const onError = (message: string) => onErrorRef.current?.(message)

    const cap = (next: SixbLogLine[]) => (next.length > max ? next.slice(next.length - max) : next)
    const append = (line: SixbLogLine) => setLines((prev) => cap([...prev, line]))
    const subscribe = (afterCursor?: string) =>
      builderNow.subscribe((line) => !cancelled && append(line), {
        afterCursor,
        reconnect,
        reconnectDelayMs,
        onError,
        onReset: () => {
          unsubscribe?.()
          unsubscribe = undefined
          void loadAndSubscribe()
        },
        onStateChange: setState,
      })

    setLines([])
    let loadGeneration = 0
    const loadAndSubscribe = async () => {
      const generation = ++loadGeneration
      try {
        const initial = await builderNow.tail({ limit: history })
        if (cancelled) return
        if (generation !== loadGeneration) return
        const seed = cap([...initial.lines])
        setLines(seed)
        unsubscribe = subscribe(seed.at(-1)?.cursor ?? initial.cursor)
      } catch (error) {
        if (cancelled) return
        onError(error instanceof Error ? error.message : String(error))
        // Still open a live tail even when history failed to load.
        unsubscribe = subscribe()
      }
    }
    void loadAndSubscribe()

    return () => {
      cancelled = true
      loadGeneration += 1
      unsubscribe?.()
    }
  }, [enabled, irKey, history, max, reconnect, reconnectDelayMs])

  return { lines, connected: state.connected, error: state.error }
}
