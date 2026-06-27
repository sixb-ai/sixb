import {
  type AuthorizationContext,
  agentRunStreamDefinition,
  agentRunStreamId,
  type BrokerRecord,
  isAllowed,
  type OntologySource,
  type Principal,
  type Sixb,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { z } from "zod"
import type { SixbServer } from "../../server"
import { decodeWsMessage, safeSend } from "../../utils/ws"

interface AgentStreamSubscriptionState {
  runId: string | null
  unsubscribe: (() => void) | null
}

const SubscribeSchema = z.object({
  type: z.literal("subscribe"),
  runId: z.string().min(1),
  /**
   * Optional because a run row is not reserved until the worker claims the job.
   * Authenticated callers should include the thread id returned by POST
   * /api/agent-threads/:threadId/messages when subscribing before pickup.
   */
  threadId: z.string().min(1).optional(),
  afterCursor: z.string().min(1).optional(),
})

const ReplaySchema = z.object({
  type: z.literal("replay"),
  runId: z.string().min(1),
  threadId: z.string().min(1).optional(),
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
    readonly threadId?: string
    readonly authz: AuthorizationContext | null
  }
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Auth-disabled development runtimes are privileged, matching the existing
  // HTTP agent routes. The server auth guard ensures auth-enabled websocket
  // requests are authenticated before they reach this route.
  if (!input.authz) {
    return { ok: true }
  }

  const storage = sixb.storage.agents
  if (!storage) {
    return { ok: false, message: "Agent storage is not configured." }
  }

  const run = await storage.runs.getById({ projectId: sixb.id, id: input.runId })
  const threadId = run?.threadId ?? input.threadId
  if (!threadId) {
    return {
      ok: false,
      message: "Agent run not found. Include threadId when subscribing before the run starts.",
    }
  }

  const thread = await storage.threads.getById({ projectId: sixb.id, id: threadId })
  if (!thread || (run && thread.id !== run.threadId)) {
    return { ok: false, message: "Agent run not found." }
  }

  if (!principalsEqual(input.authz.principal, thread.ownerPrincipal)) {
    return { ok: false, message: "Agent run not found." }
  }

  if (!isAllowed(input.authz, { kind: "agent.run", agentId: thread.agentId })) {
    return { ok: false, message: "Agent run not found." }
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
        safeSend(ws, { type: "error", message: parsed.error })
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
    threadId: message.threadId,
    authz: wsAuthz(ws),
  })
  if (!access.ok) {
    safeSend(ws, { type: "error", message: access.message })
    return
  }

  const streamId = agentRunStreamId(message.runId)
  try {
    await sixb.broker.ensureStream({
      projectId: sixb.id,
      stream: agentRunStreamDefinition(message.runId),
    })
  } catch (error) {
    safeSend(ws, { type: "error", message: errorMessage(error) })
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
    safeSend(ws, { type: "error", message: errorMessage(error) })
    return
  }

  safeSend(ws, {
    type: "subscribed",
    runId: message.runId,
    afterCursor: message.afterCursor ?? null,
  })
  live = true
  sendRecords(ws, buffered)
}

async function replayAgentStream(
  server: SixbServer,
  ws: { send: (message: string) => void },
  message: ReplayMessage
): Promise<void> {
  const sixb = server.getSixb()
  const access = await canAccessAgentRunStream(sixb, {
    runId: message.runId,
    threadId: message.threadId,
    authz: wsAuthz(ws),
  })
  if (!access.ok) {
    safeSend(ws, { type: "error", message: access.message })
    return
  }

  const streamId = agentRunStreamId(message.runId)
  try {
    await sixb.broker.ensureStream({
      projectId: sixb.id,
      stream: agentRunStreamDefinition(message.runId),
    })
    const records = await sixb.broker.read({
      projectId: sixb.id,
      streamId,
      afterCursor: message.afterCursor,
      limit: message.limit,
    })
    sendRecords(ws, records)
    safeSend(ws, {
      type: "replayed",
      runId: message.runId,
      afterCursor: records.at(-1)?.cursor ?? message.afterCursor ?? null,
      count: records.length,
    })
  } catch (error) {
    safeSend(ws, { type: "error", message: errorMessage(error) })
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

function sendRecords(
  ws: { send: (message: string) => void },
  records: readonly BrokerRecord[]
): void {
  for (const record of records) {
    safeSend(ws, { type: "record", record })
  }
}

function wsStateKey(ws: object): object {
  const raw = (ws as { raw?: unknown }).raw
  return raw && typeof raw === "object" ? raw : ws
}

function wsAuthz(ws: object): AuthorizationContext | null {
  const data = (ws as { data?: { authz?: AuthorizationContext | null } }).data
  return data?.authz ?? null
}

function principalsEqual(left: Principal, right: Principal): boolean {
  return left.type === right.type && left.id === right.id
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
