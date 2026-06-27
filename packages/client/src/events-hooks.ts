/**
 * React hooks over the `events(Type)` builder (`@sixb/client/hooks`).
 *
 * Each hook takes a built builder as its first argument — the same
 * `hook(builder())` shape as `useObjectsQuery(objects(Type).query())` — and
 * subscribes through the builder's transport. `@tanstack/react-query` and
 * `react` are optional peers, so these hooks live behind the `./hooks` subpath
 * and never the root barrel.
 */
import { useQueryClient } from "@tanstack/react-query"
import { startTransition, useCallback, useEffect, useRef, useState } from "react"
import type { SixbEvent, SixbEventOfType } from "./events"
import type { SubscribableEvents } from "./events-builder"
import type { EventSocketState } from "./events-transport"
import { type TelemetryUpdate, telemetryUpdateFromEvent } from "./telemetry-events"

const DISCONNECTED: EventSocketState = { connected: false, reconnecting: false, error: null }

export interface UseEventsOptions {
  readonly enabled?: boolean
  readonly afterCursor?: string
  readonly limit?: number
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  readonly onError?: (error: string) => void
}

/**
 * Subscribe to a builder's events. Replaces `useSixbEvents`: `onEvent` is kept
 * in a ref so changing the handler never tears down the socket, and the
 * subscription is rebuilt only when the filter IR (or transport options) change.
 */
export function useEvents<TEvent extends SixbEvent>(
  builder: SubscribableEvents<TEvent>,
  onEvent: (event: TEvent) => void,
  options?: UseEventsOptions
): EventSocketState {
  const builderRef = useRef(builder)
  builderRef.current = builder
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const onErrorRef = useRef(options?.onError)
  onErrorRef.current = options?.onError

  const [state, setState] = useState<EventSocketState>(DISCONNECTED)

  const enabled = options?.enabled ?? true
  const afterCursor = options?.afterCursor
  const limit = options?.limit
  const reconnect = options?.reconnect
  const reconnectDelayMs = options?.reconnectDelayMs
  const irKey = JSON.stringify(builder.ir)

  // Re-subscribe only when the serialized filter IR (or a transport option)
  // changes; the builder and handler are read through refs, so identity churn
  // on every render never tears the socket down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: irKey is the reactive proxy for builder.ir, read via builderRef
  useEffect(() => {
    if (!enabled) {
      setState(DISCONNECTED)
      return
    }

    const unsubscribe = builderRef.current.subscribe((event) => onEventRef.current(event), {
      afterCursor,
      limit,
      reconnect,
      reconnectDelayMs,
      onError: (message) => onErrorRef.current?.(message),
      onStateChange: setState,
    })

    return unsubscribe
  }, [enabled, irKey, afterCursor, limit, reconnect, reconnectDelayMs])

  return state
}

/** Telemetry builder accepted by the latest-value hooks. */
type TelemetryEvents = SubscribableEvents<SixbEventOfType<"telemetry.appended">>

/**
 * Track the latest telemetry update per property. The keying is by `propertyId`,
 * so scope the builder to a single object (`events(Type).object(key).telemetry()`)
 * for a per-object view, or use `useLatestByObject` to bucket by object.
 */
export function useLatest(
  builder: TelemetryEvents,
  options?: UseEventsOptions
): { values: Record<string, TelemetryUpdate>; connected: boolean } {
  const [values, setValues] = useState<Record<string, TelemetryUpdate>>({})

  const { connected } = useEvents(
    builder,
    (event) => {
      const update = telemetryUpdateFromEvent(event)
      setValues((prev) => ({ ...prev, [update.propertyId]: update }))
    },
    options
  )

  return { values, connected }
}

/** Track the latest telemetry update per property, bucketed by object id. */
export function useLatestByObject(
  builder: TelemetryEvents,
  options?: UseEventsOptions
): { byObject: Record<string, Record<string, TelemetryUpdate>>; connected: boolean } {
  const [byObject, setByObject] = useState<Record<string, Record<string, TelemetryUpdate>>>({})

  const { connected } = useEvents(
    builder,
    (event) => {
      const update = telemetryUpdateFromEvent(event)
      setByObject((prev) => ({
        ...prev,
        [update.objectId]: { ...prev[update.objectId], [update.propertyId]: update },
      }))
    },
    options
  )

  return { byObject, connected }
}

export interface UseInvalidateOnEventOptions extends UseEventsOptions {
  /** Coalesce invalidations into one flush after this many ms (default: 0). */
  readonly debounceMs?: number
}

type QueryKeyInput = readonly unknown[]

/**
 * Invalidate query keys when matching events arrive. `resolveKeys` maps an event
 * to the keys to invalidate; keys are de-duplicated and, with `debounceMs`,
 * coalesced into a single flush — the live-update pattern apps reimplement by
 * hand. Invalidation runs inside `startTransition` to keep refetches off the
 * critical render path.
 */
export function useInvalidateOnEvent<TEvent extends SixbEvent>(
  builder: SubscribableEvents<TEvent>,
  resolveKeys: (event: TEvent) => readonly QueryKeyInput[],
  options?: UseInvalidateOnEventOptions
): EventSocketState {
  const queryClient = useQueryClient()
  const resolveKeysRef = useRef(resolveKeys)
  resolveKeysRef.current = resolveKeys
  const pendingRef = useRef(new Map<string, QueryKeyInput>())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debounceMs = options?.debounceMs ?? 0

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const keys = Array.from(pendingRef.current.values())
    pendingRef.current.clear()
    if (keys.length === 0) return

    startTransition(() => {
      for (const queryKey of keys) {
        void queryClient.invalidateQueries({ queryKey })
      }
    })
  }, [queryClient])

  const state = useEvents(
    builder,
    (event) => {
      for (const key of resolveKeysRef.current(event)) {
        pendingRef.current.set(JSON.stringify(key), key)
      }
      if (debounceMs > 0) {
        if (!timerRef.current) timerRef.current = setTimeout(flush, debounceMs)
      } else {
        flush()
      }
    },
    options
  )

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return state
}
