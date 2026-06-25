import type {
  AgentDefinition,
  AgentRunRecord,
  AgentRunUsage,
  AgentStorage,
  SixbMessage,
} from "@sixb/core"
import { AgentStorageError, createAgentMessageId, fromAiSdk, toModelMessages } from "@sixb/core"
import { type LanguageModelUsage, type ModelMessage, stepCountIs, streamText } from "ai"
import { AgentLeaseLostError, AgentWorkerError } from "./errors"
import type { AgentWorkerContext, StreamSink } from "./types"

export const DEFAULT_MAX_STEPS = 8

export interface RunAgentTurnInput {
  /** The worker's stable execution context (storage, tools, stream sink, lease timings). */
  readonly context: AgentWorkerContext
  readonly agent: AgentDefinition
  /** The run this worker already reserved (or reclaimed). We own `run.lease`. */
  readonly run: AgentRunRecord
  /** The worker's shutdown signal. */
  readonly signal: AbortSignal
}

/**
 * Drive one agent turn to completion and persist it.
 *
 * Loads thread history, streams the model with the configured stop condition, keeps the run lease
 * fresh with a heartbeat, then persists the assistant message and finalizes the run with usage +
 * finish reason — all fenced on the lease id. If the lease is lost mid-turn (we were reclaimed as a
 * suspected crash), it throws {@link AgentLeaseLostError} and writes nothing: the run is no longer
 * ours.
 *
 * On success it returns the finalized (`succeeded`) run record. Model/tool failures and shutdown
 * aborts propagate to the caller (the worker), which records the run's terminal fate.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentRunRecord> {
  const { context, agent, run, signal } = input
  const {
    id: projectId,
    storage,
    tools,
    streamSink,
    leaseMs,
    heartbeatMs,
    defaultMaxSteps,
  } = context
  const runId = run.id
  const leaseId = run.lease?.id
  if (!leaseId) {
    throw new AgentWorkerError(`Agent run '${runId}' has no lease to run under.`)
  }

  const history = await storage.messages.list({ projectId, threadId: run.threadId, order: "asc" })
  // `toModelMessages` is core's `ai`-free mirror of `convertToModelMessages`. The only type gap is
  // `providerOptions`, which core types as the wider `JsonValue` (it cannot depend on `ai`); the
  // values originate from the SDK, so the runtime shape is compatible. The worker is where `ai`
  // lives, so this single boundary cast belongs here. Locked by `tests/ai-sdk-compat.types.ts`.
  const modelMessages = toModelMessages(history.messages) as ModelMessage[]

  const maxSteps = agent.loop?.stopWhen?.maxSteps ?? defaultMaxSteps

  // The model call is aborted either by worker shutdown or by the heartbeat detecting a lost lease.
  const heartbeatAbort = new AbortController()
  const abortSignal = AbortSignal.any([signal, heartbeatAbort.signal])

  const result = streamText({
    model: agent.model,
    system: agent.instructions,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal,
  })

  let responseMessage: SixbInboundLike | undefined
  const uiStream = result.toUIMessageStream({
    onFinish: (event) => {
      responseMessage = event.responseMessage
    },
  })

  let leaseLost = false
  const heartbeat = startLeaseHeartbeat({
    storage,
    projectId,
    runId,
    leaseId,
    leaseMs,
    heartbeatMs,
    onLost: () => {
      leaseLost = true
      heartbeatAbort.abort(new AgentLeaseLostError(runId))
    },
  })

  let drainError: unknown
  try {
    // Draining the UI stream drives the model loop and fires `onFinish`. We do not forward chunks
    // here — V1 emits final parts to the sink below (see `StreamSink`).
    for await (const _chunk of uiStream) {
      // intentional drain
    }
  } catch (error) {
    drainError = error
  } finally {
    heartbeat.stop()
  }

  if (leaseLost) {
    throw new AgentLeaseLostError(runId)
  }
  if (drainError !== undefined) {
    throw drainError
  }
  if (!responseMessage) {
    throw new AgentWorkerError(`Agent run '${runId}' produced no response message.`)
  }

  const assistant: SixbMessage = fromAiSdk(responseMessage)

  // One last renew right before we write: a successful renew proves we still hold the lease, and it
  // pushes expiry out by `leaseMs`, so the (lease-unfenced) message append cannot race a reclaim.
  await renewOrLost({ storage, projectId, runId, leaseId, leaseMs })

  for (const part of assistant.parts) {
    await emitPart(streamSink, part)
  }

  await storage.messages.append({
    id: createAgentMessageId(),
    projectId,
    threadId: run.threadId,
    runId,
    role: assistant.role,
    parts: assistant.parts,
    ...(assistant.metadata === undefined ? {} : { metadata: assistant.metadata }),
  })

  const usage = mapUsage(await result.totalUsage)
  const finishReason = await result.finishReason

  return storage.runs.finish({
    projectId,
    id: runId,
    leaseId,
    status: "succeeded",
    modelId: agent.model.modelId,
    finishReason,
    ...(usage === undefined ? {} : { usage }),
  })
}

// `toUIMessageStream`'s `onFinish` hands back the SDK `UIMessage`; `fromAiSdk` accepts the wider
// inbound shape. We keep the parameter loose here and let `fromAiSdk` narrow/validate at runtime.
type SixbInboundLike = Parameters<typeof fromAiSdk>[0]

interface LeaseHeartbeatInput {
  readonly storage: AgentStorage
  readonly projectId: string
  readonly runId: string
  readonly leaseId: string
  readonly leaseMs: number
  readonly heartbeatMs: number
  readonly onLost: () => void
}

/** A self-rescheduling timer that renews the run lease until stopped or the lease is lost. */
function startLeaseHeartbeat(input: LeaseHeartbeatInput): { stop(): void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    if (stopped) {
      return
    }
    try {
      await input.storage.runs.renewLease({
        projectId: input.projectId,
        id: input.runId,
        leaseId: input.leaseId,
        expiresAt: new Date(Date.now() + input.leaseMs),
      })
    } catch (error) {
      if (isLeaseGone(error)) {
        input.onLost()
        return
      }
      // Transient storage error: leave the lease as-is and try again on the next tick.
    }
    schedule()
  }

  const schedule = (): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => void tick(), input.heartbeatMs)
  }

  schedule()
  return {
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
      }
    },
  }
}

async function renewOrLost(input: {
  readonly storage: AgentStorage
  readonly projectId: string
  readonly runId: string
  readonly leaseId: string
  readonly leaseMs: number
}): Promise<void> {
  try {
    await input.storage.runs.renewLease({
      projectId: input.projectId,
      id: input.runId,
      leaseId: input.leaseId,
      expiresAt: new Date(Date.now() + input.leaseMs),
    })
  } catch (error) {
    if (isLeaseGone(error)) {
      throw new AgentLeaseLostError(input.runId)
    }
    throw error
  }
}

function isLeaseGone(error: unknown): boolean {
  return (
    error instanceof AgentStorageError &&
    (error.code === "lease_lost" ||
      error.code === "invalid_state" ||
      error.code === "run_not_found")
  )
}

async function emitPart(sink: StreamSink, part: SixbMessage["parts"][number]): Promise<void> {
  try {
    await sink.onPart(part)
  } catch (error) {
    // The sink is observational; never let it break the turn.
    console.error("[SixbAgentWorker] Stream sink failed:", error)
  }
}

/** Map AI SDK v6 usage onto the stored {@link AgentRunUsage}, dropping unknown fields. */
function mapUsage(usage: LanguageModelUsage): AgentRunUsage | undefined {
  const mapped: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
  } = {}
  if (usage.inputTokens !== undefined) {
    mapped.inputTokens = usage.inputTokens
  }
  if (usage.outputTokens !== undefined) {
    mapped.outputTokens = usage.outputTokens
  }
  if (usage.totalTokens !== undefined) {
    mapped.totalTokens = usage.totalTokens
  }
  const reasoning = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens
  if (reasoning !== undefined) {
    mapped.reasoningTokens = reasoning
  }
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens
  if (cached !== undefined) {
    mapped.cachedInputTokens = cached
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined
}
