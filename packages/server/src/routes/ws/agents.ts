import type { OntologySource } from "@sixb/core"
import {
  AGENT_ACTIVITY_STREAM_ID,
  type AgentRunActivityEvent,
  agentActivityStreamDefinition,
  agentRunStreamDefinition,
  agentRunStreamId,
  isAgentRunActivityEvent,
} from "@sixb/core/agents/streams"
import { BrokerCursorExpiredError, type BrokerRecord } from "@sixb/core/broker"
import type { Sixb } from "@sixb/core/internal/request-execution"
import type { Elysia } from "elysia"
import { z } from "zod"
import type { SixbServer } from "../../server"
import { decodeWsMessage, safeSend, wsRequestSixb, wsStateKey } from "../../utils/ws"
import { serializeAgentRun } from "../agents"

interface AgentStreamSubscriptionState {
  channel: "run" | "activity" | null
  runId: string | null
  unsubscribe: (() => void) | null
}

const SubscribeSchema = z.object({
  type: z.literal("subscribe"),
  runId: z.string().min(1),
  afterCursor: z.string().min(1).optional(),
})

const SubscribeActivitySchema = z.object({
  type: z.literal("subscribe.activity"),
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

const AgentStreamMessageSchema = z.union([
  SubscribeSchema,
  SubscribeActivitySchema,
  ReplaySchema,
  UnsubscribeSchema,
])

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
  runId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const run = await sixb.agents.runs.getById(runId)
  if (!run) {
    return { ok: false, message: "Agent run not found." }
  }
  return { ok: true }
}

export async function canAccessAgentThreadActivity(
  sixb: Sixb<readonly OntologySource[]>,
  event: AgentRunActivityEvent
): Promise<boolean> {
  const thread = await sixb.agents.threads.getById(event.threadId)
  return thread?.agentId === event.agentId
}

export function registerAgentStreamRoutes(app: Elysia, server: SixbServer) {
  const states = new WeakMap<object, AgentStreamSubscriptionState>()

  return app.ws("/ws/agents", {
    open(ws) {
      states.set(wsStateKey(ws), { channel: null, runId: null, unsubscribe: null })
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

      if (parsed.data.type === "subscribe.activity") {
        await subscribeAgentActivity(states, server, ws)
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
  const host = server.getHost()
  const sixb = wsRequestSixb(ws)
  if (!sixb) {
    safeSend(ws, { type: "error", message: "Execution scope is not available." })
    return
  }
  const access = await canAccessAgentRunStream(sixb, message.runId)
  if (!access.ok) {
    safeSend(ws, { type: "error", message: access.message })
    return
  }

  const streamId = agentRunStreamId(message.runId)
  try {
    await host.broker.ensureStream({
      projectId: host.id,
      stream: agentRunStreamDefinition(message.runId),
    })
  } catch (error) {
    safeSend(ws, { type: "error", message: errorMessage(error) })
    return
  }

  const state = states.get(wsStateKey(ws)) ?? {
    channel: null,
    runId: null,
    unsubscribe: null,
  }
  stopSubscription(state)
  states.set(wsStateKey(ws), state)

  const buffered: BrokerRecord[] = []
  let live = false
  const receive = (records: readonly BrokerRecord[]): void => {
    if (!live) {
      buffered.push(...records)
      return
    }
    sendRecords(ws, records)
  }

  // Set when the requested cursor had already been trimmed, so the client learns its resume point
  // is gone instead of silently receiving a stream that starts after the gap.
  let resumedFromEarliest = false
  try {
    state.unsubscribe = await host.broker.subscribe(
      {
        projectId: host.id,
        streamId,
        ...(message.afterCursor === undefined
          ? { from: "earliest" as const }
          : { afterCursor: message.afterCursor }),
      },
      receive
    )
    state.channel = "run"
    state.runId = message.runId
  } catch (error) {
    // Retention can outrun a paused tab: an agent run stream keeps 5000 records and a streamed
    // turn writes one per chunk. Replaying everything still retained beats leaving the socket
    // open with a cursor the broker will reject forever.
    if (error instanceof BrokerCursorExpiredError) {
      try {
        state.unsubscribe = await host.broker.subscribe(
          { projectId: host.id, streamId, from: "earliest" },
          receive
        )
        state.channel = "run"
        state.runId = message.runId
        resumedFromEarliest = true
      } catch (retryError) {
        state.unsubscribe = null
        state.channel = null
        state.runId = null
        safeSend(ws, { type: "error", message: errorMessage(retryError) })
        return
      }
    } else {
      state.unsubscribe = null
      state.channel = null
      state.runId = null
      safeSend(ws, { type: "error", message: errorMessage(error) })
      return
    }
  }

  safeSend(ws, {
    type: "subscribed",
    runId: message.runId,
    afterCursor: resumedFromEarliest ? null : (message.afterCursor ?? null),
  })
  sendRecords(ws, buffered.splice(0))
  if (!(await sendRunSnapshot(sixb, ws, message.runId))) {
    stopSubscription(state)
    return
  }
  live = true
  sendRecords(ws, buffered.splice(0))
}

async function subscribeAgentActivity(
  states: WeakMap<object, AgentStreamSubscriptionState>,
  server: SixbServer,
  ws: { send: (message: string) => void }
): Promise<void> {
  const host = server.getHost()
  const sixb = wsRequestSixb(ws)
  if (!sixb) {
    safeSend(ws, { type: "error", message: "Execution scope is not available." })
    return
  }

  try {
    await host.broker.ensureStream({
      projectId: host.id,
      stream: agentActivityStreamDefinition(),
    })
  } catch (error) {
    safeSend(ws, { type: "error", message: errorMessage(error) })
    return
  }

  const state = states.get(wsStateKey(ws)) ?? {
    channel: null,
    runId: null,
    unsubscribe: null,
  }
  stopSubscription(state)
  states.set(wsStateKey(ws), state)

  try {
    state.unsubscribe = await host.broker.subscribe(
      {
        projectId: host.id,
        streamId: AGENT_ACTIVITY_STREAM_ID,
        from: "latest",
      },
      (records) => {
        void sendVisibleActivityRecords(sixb, ws, records)
      }
    )
    state.channel = "activity"
  } catch (error) {
    state.unsubscribe = null
    state.channel = null
    safeSend(ws, { type: "error", message: errorMessage(error) })
    return
  }

  // The client reconciles its durable thread query on every subscription, closing the race between
  // the initial HTTP snapshot and this live subscription and recovering changes missed offline.
  safeSend(ws, { type: "subscribed.activity" })
}

async function sendVisibleActivityRecords(
  sixb: Sixb<readonly OntologySource[]>,
  ws: { send: (message: string) => void },
  records: readonly BrokerRecord[]
): Promise<void> {
  for (const record of records) {
    if (!isAgentRunActivityEvent(record.payload)) continue
    if (!(await canAccessAgentThreadActivity(sixb, record.payload))) continue
    safeSend(ws, { type: "activity", event: record.payload })
  }
}

async function replayAgentStream(
  server: SixbServer,
  ws: { send: (message: string) => void },
  message: ReplayMessage
): Promise<void> {
  const host = server.getHost()
  const sixb = wsRequestSixb(ws)
  if (!sixb) {
    safeSend(ws, { type: "error", message: "Execution scope is not available." })
    return
  }
  const access = await canAccessAgentRunStream(sixb, message.runId)
  if (!access.ok) {
    safeSend(ws, { type: "error", message: access.message })
    return
  }

  const streamId = agentRunStreamId(message.runId)
  try {
    await host.broker.ensureStream({
      projectId: host.id,
      stream: agentRunStreamDefinition(message.runId),
    })
    const page = await host.broker.read({
      projectId: host.id,
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
  const previousChannel = state?.channel ?? null

  if (!message.runId || previousRunId === null || message.runId === previousRunId) {
    stopSubscription(state)
  }

  safeSend(
    ws,
    previousChannel === "activity"
      ? { type: "unsubscribed.activity" }
      : { type: "unsubscribed", runId: message.runId ?? previousRunId }
  )
}

function stopSubscription(state: AgentStreamSubscriptionState | undefined): void {
  if (!state) {
    return
  }
  state.unsubscribe?.()
  state.unsubscribe = null
  state.channel = null
  state.runId = null
}

async function sendRunSnapshot(
  sixb: Sixb<readonly OntologySource[]>,
  ws: { send: (message: string) => void },
  runId: string
): Promise<boolean> {
  try {
    const run = await sixb.agents.runs.getById(runId)
    if (!run) {
      safeSend(ws, { type: "error", message: "Agent run not found." })
      return false
    }
    safeSend(ws, {
      type: "run.snapshot",
      run: serializeAgentRun(run),
    })
    return true
  } catch (error) {
    safeSend(ws, { type: "error", message: errorMessage(error) })
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
