import type { AuthorizationContext, OntologySource, Sixb } from "@sixb/core"
import { agentRunStreamDefinition, agentRunStreamId } from "@sixb/core/agents/streams"
import type { BrokerRecord } from "@sixb/core/broker"
import type { SixbErrorCode } from "@sixb/core/errors"
import type { Elysia } from "elysia"
import { z } from "zod"
import type { SixbServer } from "../../server"
import {
  decodeWsMessage,
  safeSend,
  wsAuthz,
  wsError,
  wsErrorFrom,
  wsStateKey,
} from "../../utils/ws"
import { serializeAgentRun } from "../agents"

interface AgentStreamSubscriptionState {
  runId: string | null
  unsubscribe: (() => void) | null
}

const SubscribeSchema = z.object({
  type: z.literal("subscribe"),
  runId: z.string().min(1),
  afterCursor: z.string().min(1).optional(),
})

const ReplaySchema = z.object({
  type: z.literal("replay"),
  runId: z.string().min(1),
  afterCursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
})

const UnsubscribeSchema = z.object({
  type: z.literal("unsubscribe"),
  runId: z.string().min(1).optional(),
})

const AgentStreamMessageSchema = z.union([SubscribeSchema, ReplaySchema, UnsubscribeSchema])

type SubscribeMessage = z.infer<typeof SubscribeSchema>
type ReplayMessage = z.infer<typeof ReplaySchema>
type UnsubscribeMessage = z.infer<typeof UnsubscribeSchema>

export function parseAgentStreamMessage(payload: unknown):
  | {
      ok: true
      data: z.infer<typeof AgentStreamMessageSchema>
    }
  | {
      ok: false
      error: string
    } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Message must be a JSON object." }
  }

  const parsed = AgentStreamMessageSchema.safeParse(payload)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid websocket message.",
    }
  }

  return { ok: true, data: parsed.data }
}

export async function canAccessAgentRunStream(
  sixb: Sixb<readonly OntologySource[]>,
  input: {
    readonly runId: string
    readonly authz: AuthorizationContext | null
  }
): Promise<{ ok: true } | { ok: false; code: SixbErrorCode; message: string }> {
  const storage = sixb.storage.agents
  if (!storage) {
    return {
      ok: false,
      code: "runtime.not_configured",
      message: "Agent storage is not configured.",
    }
  }

  const run = await storage.runs.getById({ projectId: sixb.id, id: input.runId })
  if (!run) {
    return { ok: false, code: "agent.run_not_found", message: "Agent run not found." }
  }

  // Auth-disabled development runtimes are privileged, matching the existing HTTP agent routes.
  if (!input.authz) {
    return { ok: true }
  }

  // Reuse the one owner + `run:agent` rule instead of re-implementing it here: the scoped surface
  // returns null for a thread the caller may not read (absent, not owner, or ungranted).
  const thread = await sixb.as(input.authz).getThread(run.threadId)
  if (!thread) {
    // Deliberately the same answer as an absent run: a caller who may not read the thread must not
    // learn that the run exists.
    return { ok: false, code: "agent.run_not_found", message: "Agent run not found." }
  }

  return { ok: true }
}

export function registerAgentStreamRoutes(app: Elysia, server: SixbServer) {
  const states = new WeakMap<object, AgentStreamSubscriptionState>()

  return app.ws("/ws/agents", {
    open(ws) {
      states.set(wsStateKey(ws), { runId: null, unsubscribe: null })
      safeSend(ws, { type: "connected", channel: "agents" })
    },

    async message(ws, message) {
      const decoded = await decodeWsMessage(message)
      const parsed = parseAgentStreamMessage(decoded)
      if (!parsed.ok) {
        safeSend(ws, wsError("runtime.invalid_input", parsed.error))
        return
      }

      if (parsed.data.type === "unsubscribe") {
        unsubscribeAgentStream(states, ws, parsed.data)
        return
      }

      if (parsed.data.type === "replay") {
        await replayAgentStream(server, ws, parsed.data)
        return
      }

      await subscribeAgentStream(states, server, ws, parsed.data)
    },

    close(ws) {
      stopSubscription(states.get(wsStateKey(ws)))
      states.delete(wsStateKey(ws))
    },
  })
}

async function subscribeAgentStream(
  states: WeakMap<object, AgentStreamSubscriptionState>,
  server: SixbServer,
  ws: { send: (message: string) => void },
  message: SubscribeMessage
): Promise<void> {
  const sixb = server.getSixb()
  const access = await canAccessAgentRunStream(sixb, {
    runId: message.runId,
    authz: wsAuthz(ws),
  })
  if (!access.ok) {
    safeSend(ws, wsError(access.code, access.message))
    return
  }

  const streamId = agentRunStreamId(message.runId)
  try {
    await sixb.broker.ensureStream({
      projectId: sixb.id,
      stream: agentRunStreamDefinition(message.runId),
    })
  } catch (error) {
    safeSend(ws, wsErrorFrom(error, "runtime.unexpected"))
    return
  }

  const state = states.get(wsStateKey(ws)) ?? { runId: null, unsubscribe: null }
  stopSubscription(state)
  states.set(wsStateKey(ws), state)

  const buffered: BrokerRecord[] = []
  let live = false
  try {
    state.unsubscribe = await sixb.broker.subscribe(
      {
        projectId: sixb.id,
        streamId,
        ...(message.afterCursor === undefined
          ? { from: "earliest" as const }
          : { afterCursor: message.afterCursor }),
      },
      (records) => {
        if (!live) {
          buffered.push(...records)
          return
        }
        sendRecords(ws, records)
      }
    )
    state.runId = message.runId
  } catch (error) {
    state.unsubscribe = null
    state.runId = null
    safeSend(ws, wsErrorFrom(error, "runtime.unexpected"))
    return
  }

  safeSend(ws, {
    type: "subscribed",
    runId: message.runId,
    afterCursor: message.afterCursor ?? null,
  })
  sendRecords(ws, buffered.splice(0))
  if (!(await sendRunSnapshot(sixb, ws, message.runId))) {
    stopSubscription(state)
    return
  }
  live = true
  sendRecords(ws, buffered.splice(0))
}

async function replayAgentStream(
  server: SixbServer,
  ws: { send: (message: string) => void },
  message: ReplayMessage
): Promise<void> {
  const sixb = server.getSixb()
  const access = await canAccessAgentRunStream(sixb, {
    runId: message.runId,
    authz: wsAuthz(ws),
  })
  if (!access.ok) {
    safeSend(ws, wsError(access.code, access.message))
    return
  }

  const streamId = agentRunStreamId(message.runId)
  try {
    await sixb.broker.ensureStream({
      projectId: sixb.id,
      stream: agentRunStreamDefinition(message.runId),
    })
    const page = await sixb.broker.read({
      projectId: sixb.id,
      streamId,
      afterCursor: message.afterCursor,
      limit: message.limit,
    })
    sendRecords(ws, page.records)
    safeSend(ws, {
      type: "replayed",
      runId: message.runId,
      afterCursor: page.cursor ?? message.afterCursor ?? null,
      count: page.records.length,
    })
    await sendRunSnapshot(sixb, ws, message.runId)
  } catch (error) {
    safeSend(ws, wsErrorFrom(error, "runtime.unexpected"))
  }
}

function unsubscribeAgentStream(
  states: WeakMap<object, AgentStreamSubscriptionState>,
  ws: { send: (message: string) => void },
  message: UnsubscribeMessage
): void {
  const state = states.get(wsStateKey(ws))
  const previousRunId = state?.runId ?? null

  if (!message.runId || previousRunId === null || message.runId === previousRunId) {
    stopSubscription(state)
  }

  safeSend(ws, {
    type: "unsubscribed",
    runId: message.runId ?? previousRunId,
  })
}

function stopSubscription(state: AgentStreamSubscriptionState | undefined): void {
  if (!state) {
    return
  }
  state.unsubscribe?.()
  state.unsubscribe = null
  state.runId = null
}

async function sendRunSnapshot(
  sixb: Sixb<readonly OntologySource[]>,
  ws: { send: (message: string) => void },
  runId: string
): Promise<boolean> {
  try {
    const run = await sixb.storage.agents?.runs.getById({ projectId: sixb.id, id: runId })
    if (!run) {
      safeSend(ws, wsError("agent.run_not_found", "Agent run not found."))
      return false
    }
    safeSend(ws, { type: "run.snapshot", run: serializeAgentRun(run) })
    return true
  } catch (error) {
    safeSend(ws, wsErrorFrom(error, "runtime.unexpected"))
    return false
  }
}

function sendRecords(
  ws: { send: (message: string) => void },
  records: readonly BrokerRecord[]
): void {
  for (const record of records) {
    safeSend(ws, { type: "record", record })
  }
}
