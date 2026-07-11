/**
 * Shared event socket for the `events(Type)` hooks (`@sixb/client/hooks`).
 *
 * Without a provider, each hook opens its own WebSocket. `SixbEventsProvider`
 * multiplexes them onto a single socket: it subscribes broadly and fans each
 * event out to the registered handlers whose filter predicate matches, opening
 * on the first subscription and closing on the last. The hooks' public surface
 * is unchanged — they delegate to the registry when one is present and fall
 * back to a per-builder socket otherwise.
 */
import { createContext, createElement, type ReactNode, useContext, useEffect, useMemo } from "react"
import type { SixbEvent } from "./events"
import { buildEventPredicate, type EventsFilterSpec } from "./events-builder"
import { createEventSocket, type EventSocket, type EventSocketState } from "./events-transport"

const DISCONNECTED: EventSocketState = { connected: false, reconnecting: false, error: null }

/**
 * How long to keep an idle shared socket alive after the last subscriber leaves.
 * A quick unmount→remount (route change, StrictMode double-invoke) reuses the
 * live socket instead of dropping and reopening it.
 */
const DEFAULT_CLOSE_DELAY_MS = 3000

export interface EventsRegistrationOptions {
  readonly onError?: (error: string) => void
  readonly onStateChange?: (state: EventSocketState) => void
}

export interface EventsRegistry {
  /** Register a filtered handler on the shared socket; returns an unregister fn. */
  register(
    filter: EventsFilterSpec,
    handler: (event: SixbEvent) => void,
    options?: EventsRegistrationOptions
  ): () => void
}

interface Subscriber {
  readonly matches: (event: SixbEvent) => boolean
  readonly handler: (event: SixbEvent) => void
  readonly options?: EventsRegistrationOptions
}

export interface ManagedRegistry extends EventsRegistry {
  /** Close the shared socket and drop every registration. */
  close(): void
}

/**
 * Build a registry backed by one lazily-opened socket. The socket subscribes
 * broadly (no topic/type/scope) so adding or removing a subscriber never forces
 * a re-subscribe — which would otherwise drop events across the reconnect — and
 * each subscriber's predicate narrows the shared stream client-side.
 *
 * Trade-off: a broad subscription means the server-side object-scope filtering
 * (by `objectTypeId`/`primaryId`) is bypassed under the provider — the socket
 * receives the full authorized stream and filters in the browser. Per-event
 * visibility is still enforced server-side (`canViewEvent`); only the
 * coarse-scope narrowing moves client-side. The standalone path (no provider)
 * still pushes object scope to the server. Per-subscription server-side scoping
 * on the shared socket is not implemented.
 */
export function createEventsRegistry(
  options: { baseUrl?: string; closeDelayMs?: number } = {}
): ManagedRegistry {
  const subscribers = new Set<Subscriber>()
  const closeDelayMs = options.closeDelayMs ?? DEFAULT_CLOSE_DELAY_MS
  let socket: EventSocket | null = null
  let state: EventSocketState = DISCONNECTED
  // Carried across a true close→reopen so the new socket resumes after the last
  // event seen instead of restarting from "now" and losing the gap.
  let latestCursor: string | undefined
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  const cancelPendingClose = () => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  const teardown = () => {
    socket?.close()
    socket = null
    state = DISCONNECTED
  }

  const open = () => {
    if (socket) return
    socket = createEventSocket({
      baseUrl: options.baseUrl,
      afterCursor: latestCursor,
      onEvent: (event) => {
        latestCursor = event.cursor
        for (const subscriber of subscribers) {
          if (subscriber.matches(event)) subscriber.handler(event)
        }
      },
      onError: (message) => {
        for (const subscriber of subscribers) subscriber.options?.onError?.(message)
      },
      onStateChange: (next) => {
        state = next
        for (const subscriber of subscribers) subscriber.options?.onStateChange?.(next)
      },
    })
  }

  return {
    register(filter, handler, registrationOptions) {
      cancelPendingClose()
      const subscriber: Subscriber = {
        matches: buildEventPredicate(filter),
        handler,
        options: registrationOptions,
      }
      subscribers.add(subscriber)
      // Sync a late subscriber to the socket's current status immediately.
      registrationOptions?.onStateChange?.(state)
      open()

      return () => {
        subscribers.delete(subscriber)
        if (subscribers.size === 0) {
          // Defer teardown: a quick unmount→remount reuses the live socket.
          cancelPendingClose()
          closeTimer = setTimeout(() => {
            closeTimer = null
            teardown()
          }, closeDelayMs)
        }
      }
    },
    close() {
      cancelPendingClose()
      subscribers.clear()
      teardown()
    },
  }
}

const EventsSocketContext = createContext<EventsRegistry | null>(null)

/** The active shared-socket registry, or `null` when no provider is mounted. */
export function useEventsRegistry(): EventsRegistry | null {
  return useContext(EventsSocketContext)
}

/**
 * Multiplex every `events(Type)` hook beneath it onto one shared WebSocket.
 * Optional: hooks work without it (one socket each). `baseUrl` defaults to the
 * global client config.
 */
export function SixbEventsProvider(props: { baseUrl?: string; children?: ReactNode }) {
  const registry = useMemo(() => createEventsRegistry({ baseUrl: props.baseUrl }), [props.baseUrl])

  useEffect(() => () => registry.close(), [registry])

  return createElement(EventsSocketContext.Provider, { value: registry }, props.children)
}
