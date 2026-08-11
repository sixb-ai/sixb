import type { DomainEvent } from "@sixb/core"
import { scopeKeysForEvent } from "@sixb/core/events/scope"
import type { Elysia } from "elysia"
import { z } from "zod"
import { EVENT_TOPICS, EVENT_TYPES } from "../../schemas/events"
import type { SixbServer } from "../../server"
import { decodeWsMessage, safeSend, wsRequestSixb, wsStateKey } from "../../utils/ws"

interface EventSubscriptionState {
  topics?: DomainEvent["topic"][]
  types?: DomainEvent["type"][]
  objectTypeId?: string
  primaryId?: string
  actionId?: string
  runId?: string
  afterCursor?: string
  limit: number
  polling: boolean
  timer: ReturnType<typeof setInterval> | null
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

async function resolveLatestCursor(server: SixbServer): Promise<string | undefined> {
  return server.getHost().events.latestCursor()
}

function createDefaultState(): EventSubscriptionState {
  return {
    topics: undefined,
    types: undefined,
    objectTypeId: undefined,
    primaryId: undefined,
    actionId: undefined,
    runId: undefined,
    afterCursor: undefined,
    limit: 200,
    polling: false,
    timer: null,
    initialized: Promise.resolve(),
    initializationFailureHandled: false,
  }
}

export function registerEventStreamRoutes(app: Elysia, server: SixbServer) {
  const states = new WeakMap<object, EventSubscriptionState>()

  const awaitInitialization = async (
    ws: { close: () => void; send: (message: string) => void },
    state: EventSubscriptionState
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

  const stopPolling = (ws: object) => {
    const state = states.get(wsStateKey(ws))
    if (!state) {
      return
    }

    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
  }

  const startPolling = (ws: { send: (message: string) => void }) => {
    const state = states.get(wsStateKey(ws))
    if (!state || state.timer) {
      return
    }

    const sixb = wsRequestSixb(ws)
    if (!sixb) {
      safeSend(ws, { type: "error", message: "Execution scope is not available." })
      return
    }

    const tick = async () => {
      if (state.polling) {
        return
      }

      state.polling = true
      try {
        const p = server.getHost()
        const events = await p.events.read({
          afterCursor: state.afterCursor,
          limit: state.limit,
          topics: state.topics,
          types: state.types,
        })

        // The execution facade owns per-event visibility. The cursor still advances over every
        // record read, not only the visible ones, so an invisible tail cannot stall polling.
        for (const event of events) {
          if (!eventMatchesScope(event, state)) {
            continue
          }
          if (sixb.events.canRead(event)) {
            safeSend(ws, { type: "event", event })
          }
        }

        const last = events[events.length - 1]
        if (last) {
          state.afterCursor = last.cursor
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        safeSend(ws, { type: "error", message })
      } finally {
        state.polling = false
      }
    }

    state.timer = setInterval(() => {
      void tick()
    }, 500)

    void tick()
  }

  return app.ws("/ws/events", {
    async open(ws) {
      // Any authenticated principal may connect; events are filtered per-event
      // by grants as they stream (see the poll loop in `startPolling`).
      const state = createDefaultState()
      states.set(wsStateKey(ws), state)
      state.initialized = resolveLatestCursor(server).then((cursor) => {
        state.afterCursor = cursor
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

      const state = states.get(wsStateKey(ws))
      if (!state) {
        safeSend(ws, { type: "error", message: "Subscription state not found." })
        return
      }

      // Older clients may subscribe immediately on websocket open. Wait for the
      // initial cursor instead of allowing that message to race connection setup.
      if (!(await awaitInitialization(ws, state))) return

      if (parsed.data.type === "unsubscribe") {
        stopPolling(ws)
        state.topics = undefined
        state.types = undefined
        state.objectTypeId = undefined
        state.primaryId = undefined
        state.actionId = undefined
        state.runId = undefined
        state.afterCursor = await resolveLatestCursor(server)
        safeSend(ws, { type: "unsubscribed" })
        return
      }

      state.topics = parsed.data.topic ? [parsed.data.topic] : undefined
      state.types = parsed.data.types
      state.objectTypeId = parsed.data.objectTypeId
      state.primaryId = parsed.data.primaryId
      state.actionId = parsed.data.actionId
      state.runId = parsed.data.runId
      state.limit = parsed.data.limit ?? state.limit
      state.afterCursor = parsed.data.afterCursor ?? state.afterCursor

      startPolling(ws)
      safeSend(ws, {
        type: "subscribed",
        topic: state.topics?.[0] ?? null,
        types: state.types ?? null,
        afterCursor: state.afterCursor ?? null,
      })
    },

    close(ws) {
      stopPolling(ws)
      states.delete(wsStateKey(ws))
    },
  })
}

/**
 * Narrow an event to an optional subscription scope. Scope keys are resolved by core's
 * `scopeKeysForEvent` (the same extraction the client predicate uses), so events
 * without those keys (e.g. workflows) never match a scoped subscription.
 */
function eventMatchesScope(event: DomainEvent, filter: EventSubscriptionState): boolean {
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
