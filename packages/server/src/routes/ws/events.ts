import type { DomainEvent } from "@sixb/core"
import { scopeKeysForEvent } from "@sixb/core/internal/event-scope"
import type { StoredDomainEvent } from "@sixb/core/internal/events"
import type { Elysia } from "elysia"
import { z } from "zod"
import { EVENT_TOPICS, EVENT_TYPES } from "../../schemas/events"
import type { SixbServer } from "../../server"
import { decodeWsMessage, safeSend, wsRequestSixb, wsStateKey } from "../../utils/ws"
import { SubscriptionHub } from "./subscription-hub"

const DEFAULT_READ_LIMIT = 200

interface EventSocketState {
  /** The first subscription replays from where the stream ended when the socket opened. */
  replayFrom: { readonly afterCursor?: string } | null
  initialized: Promise<void>
  initializationFailureHandled: boolean
}

const SubscribeSchema = z.object({
  type: z.literal("subscribe"),
  topic: z.enum(EVENT_TOPICS).optional(),
  types: z.array(z.enum(EVENT_TYPES)).optional(),
  objectTypeId: z.string().optional(),
  primaryId: z.string().optional(),
  actionId: z.string().optional(),
  runId: z.string().optional(),
  afterCursor: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
})

const UnsubscribeSchema = z.object({
  type: z.literal("unsubscribe"),
})

const SubscriptionMessageSchema = z.union([SubscribeSchema, UnsubscribeSchema])

export function parseSubscriptionMessage(payload: unknown):
  | {
      ok: true
      data: z.infer<typeof SubscriptionMessageSchema>
    }
  | {
      ok: false
      error: string
    } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Message must be a JSON object." }
  }

  const parsed = SubscriptionMessageSchema.safeParse(payload)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid websocket message.",
    }
  }

  return { ok: true, data: parsed.data }
}

export function registerEventStreamRoutes(app: Elysia, server: SixbServer) {
  const events = server.getHost().events
  const states = new WeakMap<object, EventSocketState>()
  const hub = new SubscriptionHub<StoredDomainEvent>({
    subscribe: (deliver) => events.subscribe({ from: "latest" }, deliver),
    frames: (batch) => batch.map((event) => ({ type: "event", event })),
    expired: async () => ({
      type: "error",
      message: "[SixbServer] Event cursor expired; refetch current state. Live events continue.",
    }),
  })

  const awaitInitialization = async (
    ws: { close: () => void; send: (message: string) => void },
    state: EventSocketState
  ): Promise<boolean> => {
    try {
      await state.initialized
      return true
    } catch (error) {
      if (state.initializationFailureHandled) return false
      state.initializationFailureHandled = true
      const message = error instanceof Error ? error.message : String(error)
      safeSend(ws, {
        type: "error",
        message: `[SixbServer] Failed to initialize event websocket: ${message}`,
      })
      ws.close()
      return false
    }
  }

  app.onStop(() => hub.close())
  return app.ws("/ws/events", {
    async open(ws) {
      // Any authenticated principal may connect; events are filtered per-event
      // by grants as they stream (see `matches` below).
      const state: EventSocketState = {
        replayFrom: null,
        initialized: Promise.resolve(),
        initializationFailureHandled: false,
      }
      states.set(wsStateKey(ws), state)
      state.initialized = events.latestCursor().then((afterCursor) => {
        state.replayFrom = { afterCursor }
      })
      if (!(await awaitInitialization(ws, state))) return
      safeSend(ws, { type: "connected", channel: "events" })
    },

    async message(ws, message) {
      const decoded = await decodeWsMessage(message)
      const parsed = parseSubscriptionMessage(decoded)
      if (!parsed.ok) {
        safeSend(ws, { type: "error", message: parsed.error })
        return
      }

      const key = wsStateKey(ws)
      const state = states.get(key)
      if (!state) {
        safeSend(ws, { type: "error", message: "Subscription state not found." })
        return
      }

      // Older clients may subscribe immediately on websocket open. Wait for the
      // initial cursor instead of allowing that message to race connection setup.
      if (!(await awaitInitialization(ws, state))) return

      if (parsed.data.type === "unsubscribe") {
        hub.unsubscribe(key)
        safeSend(ws, { type: "unsubscribed" })
        return
      }

      const sixb = wsRequestSixb(ws)
      if (!sixb) {
        safeSend(ws, { type: "error", message: "Execution scope is not available." })
        return
      }

      const filter = parsed.data
      const topics = filter.topic ? [filter.topic] : undefined
      const limit = filter.limit ?? DEFAULT_READ_LIMIT
      // Without a cursor, a later subscription on the same socket starts with live events.
      const replayFrom =
        filter.afterCursor === undefined ? state.replayFrom : { afterCursor: filter.afterCursor }
      state.replayFrom = null
      try {
        await hub.subscribe(
          key,
          ws,
          {
            matches: (event) =>
              (!filter.topic || event.topic === filter.topic) &&
              (!filter.types?.length || filter.types.includes(event.type)) &&
              eventMatchesScope(event, filter) &&
              sixb.events.canRead(event),
            replay: replayFrom
              ? {
                  afterCursor: replayFrom.afterCursor,
                  read: async (afterCursor) => {
                    const records = await events.read({
                      afterCursor,
                      limit,
                      topics,
                      types: filter.types,
                    })
                    return {
                      records,
                      cursor: records.at(-1)?.cursor,
                      hasMore: records.length === limit,
                    }
                  },
                }
              : undefined,
          },
          () =>
            safeSend(ws, {
              type: "subscribed",
              topic: filter.topic ?? null,
              types: filter.types ?? null,
              afterCursor: replayFrom?.afterCursor ?? null,
            })
        )
      } catch (error) {
        safeSend(ws, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        })
        ws.close(1011, "Event stream setup failed")
      }
    },

    close(ws) {
      hub.unsubscribe(wsStateKey(ws))
      states.delete(wsStateKey(ws))
    },
  })
}

/**
 * Narrow an event to an optional subscription scope. Scope keys are resolved by core's
 * `scopeKeysForEvent` (the same extraction the client predicate uses), so events
 * without those keys (e.g. workflows) never match a scoped subscription.
 */
function eventMatchesScope(
  event: DomainEvent,
  filter: {
    readonly objectTypeId?: string
    readonly primaryId?: string
    readonly actionId?: string
    readonly runId?: string
  }
): boolean {
  const { objectTypeId, primaryId, actionId, runId } = filter
  if (
    objectTypeId === undefined &&
    primaryId === undefined &&
    actionId === undefined &&
    runId === undefined
  ) {
    return true
  }

  const scope = scopeKeysForEvent(event)
  if (objectTypeId !== undefined && scope.objectTypeId !== objectTypeId) {
    return false
  }
  if (primaryId !== undefined && scope.primaryId !== primaryId) {
    return false
  }
  if (actionId !== undefined && scope.actionId !== actionId) {
    return false
  }
  if (runId !== undefined && scope.runId !== runId) {
    return false
  }

  return true
}
