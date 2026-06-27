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
import { buildEventPredicate, type EventsFilterIR } from "./events-builder"
import { createEventSocket, type EventSocket, type EventSocketState } from "./events-transport"

const DISCONNECTED: EventSocketState = { connected: false, reconnecting: false, error: null }

export interface EventsRegistrationOptions {
  readonly onError?: (error: string) => void
  readonly onStateChange?: (state: EventSocketState) => void
}

export interface EventsRegistry {
  /** Register a filtered handler on the shared socket; returns an unregister fn. */
  register(
    filter: EventsFilterIR,
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
 * each subscriber's predicate narrows the shared stream.
 */
export function createEventsRegistry(options: { baseUrl?: string } = {}): ManagedRegistry {
  const subscribers = new Set<Subscriber>()
  let socket: EventSocket | null = null
  let state: EventSocketState = DISCONNECTED

  const open = () => {
    if (socket) return
    socket = createEventSocket({
      baseUrl: options.baseUrl,
      onEvent: (event) => {
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
        if (subscribers.size === 0 && socket) {
          socket.close()
          socket = null
          state = DISCONNECTED
        }
      }
    },
    close() {
      socket?.close()
      socket = null
      state = DISCONNECTED
      subscribers.clear()
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
