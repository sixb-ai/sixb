import { type Query, type QueryClient, useQueryClient } from "@tanstack/react-query"
import { startTransition, useEffect, useRef } from "react"
import { useSixbProviderClient } from "./client-provider"
import { events } from "./events"
import { useEvents } from "./events-hooks"
import { objectQueryReadsAny } from "./object-query-reads"
import { objectQueryKeys } from "./query-hooks"

const DEFAULT_WINDOW_MS = 1_000
const MINIMUM_WINDOW_MS = 100

/** Every view hears the same events, so what they gather is kept per cache. */
interface LiveUpdates {
  /** The mounted, enabled hooks. With none left, nothing should refresh. */
  listeners: number
  /** The API client whose answers say what each query reads. */
  client: object | undefined
  /** Events may have been missed, so any query could have changed. */
  everything: boolean
  /** Types changed since the last refresh. */
  readonly changed: Set<string>
  /**
   * Queries a change reached while they were fetching, by hash, with the types that changed: what
   * they are reading may predate it. A query with no answer yet can then turn out not to read them.
   */
  readonly rereads: Map<string, ReadonlySet<string> | "everything">
  windowMs: number
  cancel?: () => void
}

const liveUpdates = new WeakMap<QueryClient, LiveUpdates>()

function liveUpdatesOf(queryClient: QueryClient): LiveUpdates {
  let state = liveUpdates.get(queryClient)
  if (!state) {
    state = {
      listeners: 0,
      client: undefined,
      everything: false,
      changed: new Set(),
      rereads: new Map(),
      windowMs: DEFAULT_WINDOW_MS,
    }
    liveUpdates.set(queryClient, state)
  }
  return state
}

export interface UseObjectQueryLiveUpdatesOptions {
  /** Stop listening, for a view that must not refresh. Defaults to true. */
  readonly enabled?: boolean
  /** Refresh at most once per this long while changes arrive. Defaults to one second. */
  readonly windowMs?: number
  /** Told when the event stream fails, such as when a session ends: queries then stop refreshing. */
  readonly onError?: (error: unknown) => void
}

/**
 * Keeps cached object queries current while they are shown: mount it once, near the root.
 *
 * Object events name their type, link events their source's and target's. A query refreshes when
 * it reads one of them, through its filters, traversals or expansions. Changes gather for the
 * window, and for as long as the page is hidden, so a burst of writes refreshes each query at most
 * once per window. A query already fetching finishes first, then reads again.
 *
 * In a standalone browser app, wrap this in `SixbEventsProvider` so its two subscriptions share one
 * connection.
 */
export function useObjectQueryLiveUpdates(options: UseObjectQueryLiveUpdatesOptions = {}): void {
  const queryClient = useQueryClient()
  const client = useSixbProviderClient()
  const { enabled = true, windowMs = DEFAULT_WINDOW_MS, onError } = options
  const subscription = client ? { client } : undefined

  useEffect(() => {
    if (!enabled) return
    return listenToObjectQueryChanges(queryClient, client)
  }, [enabled, queryClient, client])

  const objectStream = useEvents(
    events.objects(subscription),
    (event) => noteObjectTypesChanged(queryClient, [event.payload.objectTypeId], windowMs),
    { enabled, onError }
  )
  const linkStream = useEvents(
    events.links(subscription),
    (event) =>
      noteObjectTypesChanged(
        queryClient,
        [event.payload.sourceTypeId, event.payload.targetTypeId],
        windowMs
      ),
    { enabled, onError }
  )

  // Per hook: another view mounting starts disconnected, which says nothing about this stream.
  const streams = useRef<Record<string, EventStreamHistory>>({})
  useEffect(() => {
    for (const [name, connected] of [
      ["objects", objectStream.connected],
      ["links", linkStream.connected],
    ] as const) {
      streams.current[name] = noteEventStreamConnected(
        queryClient,
        streams.current[name],
        connected,
        windowMs
      )
    }
  }, [queryClient, objectStream.connected, linkStream.connected, windowMs])
}

export interface EventStreamHistory {
  readonly connected: boolean
  readonly everConnected: boolean
}

/** Events sent during a dropped connection may never arrive, so anything could have changed. */
export function noteEventStreamConnected(
  queryClient: QueryClient,
  history: EventStreamHistory | undefined,
  connected: boolean,
  windowMs: number = DEFAULT_WINDOW_MS
): EventStreamHistory {
  if (connected && history?.everConnected && !history.connected) {
    const state = liveUpdatesOf(queryClient)
    if (state.listeners > 0) {
      state.everything = true
      state.windowMs = Math.max(windowMs, MINIMUM_WINDOW_MS)
      schedule(queryClient, state)
    }
  }
  return { connected, everConnected: connected || (history?.everConnected ?? false) }
}

/**
 * Returns the way to stop. The last listener to leave cancels the pending refresh, and marks what
 * it would have refreshed as stale: those events are gone, so the next mount must read again.
 */
export function listenToObjectQueryChanges(queryClient: QueryClient, client?: object): () => void {
  const state = liveUpdatesOf(queryClient)
  state.listeners += 1
  state.client = client

  if (state.rereads.size > 0) schedule(queryClient, state)

  return () => {
    state.listeners -= 1
    if (state.listeners > 0) return

    state.cancel?.()
    const stale = staleQueries(queryClient, state)
    const everything = state.everything
    const changed = new Set(state.changed)
    state.changed.clear()
    state.everything = false
    state.rereads.clear()
    if (stale.length === 0) return

    // Those events are gone, so these stay due for the next listener. A mark alone would not do: it
    // does not read an active query again, and a read in flight would clear it when it lands.
    for (const query of stale) {
      state.rereads.set(query.queryHash, everything ? "everything" : changed)
    }
    const hashes = new Set(stale.map((query) => query.queryHash))
    void queryClient.invalidateQueries({
      queryKey: objectQueryKeys.all(),
      refetchType: "none",
      predicate: (query) => hashes.has(query.queryHash),
    })
  }
}

function isFetching(query: Query): boolean {
  return query.state.fetchStatus === "fetching"
}

function staleQueries(queryClient: QueryClient, state: LiveUpdates): Query[] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: objectQueryKeys.all() })
    .filter((query) => {
      if (state.everything) return true
      if (
        state.changed.size > 0 &&
        objectQueryReadsAny(state.client, query.queryKey[3], state.changed)
      ) {
        return true
      }
      const reread = state.rereads.get(query.queryHash)
      return (
        reread === "everything" ||
        (reread !== undefined && objectQueryReadsAny(state.client, query.queryKey[3], reread))
      )
    })
}

export function noteObjectTypesChanged(
  queryClient: QueryClient,
  objectTypeIds: readonly string[],
  windowMs: number = DEFAULT_WINDOW_MS
): void {
  const state = liveUpdatesOf(queryClient)
  if (state.listeners === 0) return

  state.windowMs = Math.max(windowMs, MINIMUM_WINDOW_MS)
  for (const objectTypeId of objectTypeIds) state.changed.add(objectTypeId)
  schedule(queryClient, state)
}

function schedule(queryClient: QueryClient, state: LiveUpdates): void {
  if (state.cancel) return

  const timer = setTimeout(() => {
    state.cancel = undefined
    refreshWhenVisible(queryClient, state)
  }, state.windowMs)
  state.cancel = () => {
    clearTimeout(timer)
    state.cancel = undefined
  }
}

function refreshWhenVisible(queryClient: QueryClient, state: LiveUpdates): void {
  if (globalThis.document?.visibilityState !== "hidden") {
    refresh(queryClient, state)
    return
  }

  const showAgain = () => {
    state.cancel = undefined
    refreshWhenVisible(queryClient, state)
  }
  document.addEventListener("visibilitychange", showAgain, { once: true })
  state.cancel = () => {
    document.removeEventListener("visibilitychange", showAgain)
    state.cancel = undefined
  }
}

function refresh(queryClient: QueryClient, state: LiveUpdates): void {
  const stale = staleQueries(queryClient, state)
  const everything = state.everything
  const changed = new Set(state.changed)
  const earlier = new Map(state.rereads)
  state.changed.clear()
  state.everything = false
  state.rereads.clear()

  // Restarting a slow read for each window would mean it never finishes during a burst, and the
  // server would keep running every read it abandoned. It finishes, then reads again if what it
  // turns out to read changed.
  const ready = new Set<string>()
  for (const query of stale) {
    if (!isFetching(query)) {
      ready.add(query.queryHash)
      continue
    }
    const before = earlier.get(query.queryHash)
    state.rereads.set(
      query.queryHash,
      everything || before === "everything"
        ? "everything"
        : new Set([...(before ?? []), ...changed])
    )
  }
  if (state.rereads.size > 0) schedule(queryClient, state)
  if (ready.size === 0) return

  startTransition(() => {
    void queryClient.invalidateQueries({
      queryKey: objectQueryKeys.all(),
      predicate: (query) => ready.has(query.queryHash),
    })
  })
}
