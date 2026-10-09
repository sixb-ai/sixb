import type { LogLevel, LogRunRef, SixbRunKind, StoredLogLine } from "@sixb/core"
import type { LoggingService } from "@sixb/core/internal/logging"
import type { Elysia } from "elysia"
import { z } from "zod"
import { LOG_LEVELS, LogRunIdSchema, SIXB_RUN_KINDS } from "../../schemas/logs"
import type { SixbServer } from "../../server"
import { decodeWsMessage, safeSend, wsRequestSixb, wsStateKey } from "../../utils/ws"
import { type HubSubscription, SubscriptionHub } from "./subscription-hub"

const READ_PAGE_SIZE = 500

export interface LogSubscriptionFilter {
  readonly kinds?: readonly SixbRunKind[]
  readonly levels?: readonly LogLevel[]
  readonly run?: LogRunRef
  readonly afterCursor?: string
}

const SubscribeSchema = z
  .object({
    type: z.literal("subscribe"),
    kinds: z.array(z.enum(SIXB_RUN_KINDS)).min(1).optional(),
    levels: z.array(z.enum(LOG_LEVELS)).min(1).optional(),
    run: z
      .object({
        kind: z.enum(SIXB_RUN_KINDS),
        id: LogRunIdSchema,
      })
      .optional(),
    afterCursor: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.run && value.kinds && !value.kinds.includes(value.run.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run"],
        message: "run.kind must be included in kinds",
      })
    }
  })

const UnsubscribeSchema = z.object({ type: z.literal("unsubscribe") })
const SubscriptionMessageSchema = z.union([SubscribeSchema, UnsubscribeSchema])

export function parseLogSubscriptionMessage(
  payload: unknown
): { ok: true; data: z.infer<typeof SubscriptionMessageSchema> } | { ok: false; error: string } {
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

export function createLogSubscriptionHub(logging: LoggingService): SubscriptionHub<StoredLogLine> {
  return new SubscriptionHub({
    subscribe: (deliver) => logging.subscribe({ from: "latest" }, deliver),
    frames: (logs) => [{ type: "logs", logs }],
    expired: async () => {
      const latest = await logging.tail({ limit: 1 })
      return {
        type: "reset",
        reason: "cursor_expired",
        cursor: latest.lines.at(-1)?.cursor ?? latest.cursor,
      }
    },
  })
}

export function logSubscription(
  logging: LoggingService,
  filter: LogSubscriptionFilter
): HubSubscription<StoredLogLine> {
  return {
    matches: (line) => matchesLogFilter(line, filter),
    replay:
      filter.afterCursor === undefined
        ? undefined
        : {
            afterCursor: filter.afterCursor,
            read: async (afterCursor) => {
              const page = await logging.read({
                afterCursor,
                limit: READ_PAGE_SIZE,
                kinds: filter.kinds,
                levels: filter.levels,
                run: filter.run,
              })
              return { records: page.lines, cursor: page.cursor, hasMore: page.hasMore }
            },
          },
  }
}

export function registerLogStreamRoutes(app: Elysia, server: SixbServer) {
  const logging = server.getHost().logging
  const hub = createLogSubscriptionHub(logging)

  app.onStop(() => hub.close())
  return app.ws("/ws/logs", {
    open(ws) {
      try {
        const sixb = wsRequestSixb(ws)
        if (!sixb) throw new Error("Execution scope is not available.")
        sixb.logs.assertObservable()
      } catch {
        ws.close(1008, "Missing required capability 'observe:logs'.")
        return
      }
      safeSend(ws, { type: "connected", channel: "logs" })
    },

    async message(ws, message) {
      try {
        const sixb = wsRequestSixb(ws)
        if (!sixb) throw new Error("Execution scope is not available.")
        sixb.logs.assertObservable()
      } catch {
        ws.close(1008, "Missing required capability 'observe:logs'.")
        return
      }

      const parsed = parseLogSubscriptionMessage(await decodeWsMessage(message))
      if (!parsed.ok) {
        safeSend(ws, { type: "error", message: parsed.error })
        return
      }

      const key = wsStateKey(ws)
      if (parsed.data.type === "unsubscribe") {
        hub.unsubscribe(key)
        safeSend(ws, { type: "unsubscribed" })
        return
      }

      const subscription = parsed.data
      const levels = subscription.levels as readonly LogLevel[] | undefined
      try {
        await hub.subscribe(
          key,
          ws,
          logSubscription(logging, {
            kinds: subscription.kinds,
            levels,
            run: subscription.run,
            afterCursor: subscription.afterCursor,
          }),
          () =>
            safeSend(ws, {
              type: "subscribed",
              kinds: subscription.kinds ?? null,
              levels: levels ?? null,
              run: subscription.run ?? null,
              afterCursor: subscription.afterCursor ?? null,
            })
        )
      } catch (error) {
        safeSend(ws, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        })
        ws.close(1011, "Log stream setup failed")
      }
    },

    close(ws) {
      hub.unsubscribe(wsStateKey(ws))
    },
  })
}

function matchesLogFilter(line: StoredLogLine, filter: LogSubscriptionFilter): boolean {
  if (filter.run) {
    if (line.context.run.kind !== filter.run.kind || line.context.run.id !== filter.run.id) {
      return false
    }
  }
  if (filter.kinds && !filter.kinds.includes(line.context.run.kind)) return false
  if (filter.levels && !filter.levels.includes(line.level)) return false
  return true
}
