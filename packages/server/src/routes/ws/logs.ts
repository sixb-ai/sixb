import { isAllowed, type LogLevel } from "@sixb/core"
import type { Elysia } from "elysia"
import { z } from "zod"
import { LOG_LEVELS, LOG_RUN_KINDS, LogRunIdSchema } from "../../schemas/logs"
import type { SixbServer } from "../../server"
import { decodeWsMessage, safeSend, wsAuthz, wsStateKey } from "../../utils/ws"
import { LogSubscriptionHub } from "./log-subscription-hub"

const SubscribeSchema = z
  .object({
    type: z.literal("subscribe"),
    kinds: z.array(z.enum(LOG_RUN_KINDS)).min(1).optional(),
    levels: z.array(z.enum(LOG_LEVELS)).min(1).optional(),
    run: z
      .object({
        kind: z.enum(LOG_RUN_KINDS),
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

export function registerLogStreamRoutes(app: Elysia, server: SixbServer) {
  const hub = new LogSubscriptionHub(server.getSixb())

  app.onStop(() => hub.close())
  return app.ws("/ws/logs", {
    open(ws) {
      if (!isAllowed(wsAuthz(ws), { kind: "logs.observe" })) {
        ws.close(1008, "Missing required capability 'observe:logs'.")
        return
      }
      safeSend(ws, { type: "connected", channel: "logs" })
    },

    async message(ws, message) {
      if (!isAllowed(wsAuthz(ws), { kind: "logs.observe" })) {
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
          {
            kinds: subscription.kinds,
            levels,
            run: subscription.run,
            afterCursor: subscription.afterCursor,
          },
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
