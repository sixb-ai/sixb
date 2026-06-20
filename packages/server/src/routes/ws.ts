import { type AuthorizationContext, canViewEvent, type DomainEvent } from "@sixb/core"
import type { Elysia } from "elysia"
import { z } from "zod"
import { EVENT_TOPICS, EVENT_TYPES } from "../schemas/events"
import type { SixbServer } from "../server"
import { decodeWsMessage, safeSend } from "../utils/ws"

interface EventSubscriptionState {
  topics?: DomainEvent["topic"][]
  types?: DomainEvent["type"][]
  afterCursor?: string
  limit: number
  polling: boolean
  timer: ReturnType<typeof setInterval> | null
}

const SubscribeSchema = z.object({
  type: z.literal("subscribe"),
  topic: z.enum(EVENT_TOPICS).optional(),
  types: z.array(z.enum(EVENT_TYPES)).optional(),
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
  const p = server.getSixb()
  const events = await p.events.read()
  return events.at(-1)?.cursor
}

function createDefaultState(): EventSubscriptionState {
  return {
    topics: undefined,
    types: undefined,
    afterCursor: undefined,
    limit: 200,
    polling: false,
    timer: null,
  }
}

export function registerWsRoutes(app: Elysia, server: SixbServer) {
  const states = new WeakMap<object, EventSubscriptionState>()

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

    const authz = wsAuthz(ws)

    const tick = async () => {
      if (state.polling) {
        return
      }

      state.polling = true
      try {
        const p = server.getSixb()
        const events = await p.events.read({
          afterCursor: state.afterCursor,
          limit: state.limit,
          topics: state.topics,
          types: state.types,
        })

        // Each event payload may carry object data, so visibility is derived
        // per-event from the principal's grants (see `canViewEvent`). The cursor
        // advances over every event read, not just the ones sent.
        for (const event of events) {
          if (canViewEvent(authz, event)) {
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
      state.afterCursor = await resolveLatestCursor(server)
      states.set(wsStateKey(ws), state)
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

      if (parsed.data.type === "unsubscribe") {
        stopPolling(ws)
        state.topics = undefined
        state.types = undefined
        state.afterCursor = await resolveLatestCursor(server)
        safeSend(ws, { type: "unsubscribed" })
        return
      }

      state.topics = parsed.data.topic ? [parsed.data.topic] : undefined
      state.types = parsed.data.types
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

function wsStateKey(ws: object): object {
  const raw = (ws as { raw?: unknown }).raw
  return raw && typeof raw === "object" ? raw : ws
}

/** Read the authorization context the auth derive attached to the upgrade request. */
function wsAuthz(ws: object): AuthorizationContext | null {
  const data = (ws as { data?: { authz?: AuthorizationContext | null } }).data
  return data?.authz ?? null
}
