import type {
  AgentDefinition,
  AgentMessage,
  AgentRunRecord,
  AgentRunUsage,
  AgentStorage,
} from "@sixb/core"
import { createAgentMessageId, fromAiSdk, toModelMessages } from "@sixb/core"
import { type LanguageModelUsage, type ModelMessage, stepCountIs, streamText } from "ai"
import { AgentLeaseLostError, AgentTurnTimeoutError, AgentWorkerError } from "./errors"
import { appendMessageAndFinishRunOrThrow, isTerminalOrLeaseGone } from "./finalize"
import type { AgentTurnContext } from "./types"

export const DEFAULT_MAX_STEPS = 25
const DEFAULT_SYSTEM_CONTEXT =
  "You are operating as a Sixb agent with a sandboxed bash tool and scoped access to the current Sixb ontology API. Use live API context for object types, objects, telemetry, and declared actions; keep work grounded in the user's request, explain important assumptions briefly, and ask before making domain changes."

export interface RunAgentTurnInput {
  /** The worker's stable execution context (storage, tools, stream sink, lease timings). */
  readonly context: AgentTurnContext
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
    leaseMs,
    heartbeatMs,
    defaultMaxSteps,
    turnTimeoutMs,
  } = context
  const runId = run.id
  const leaseId = run.lease?.id
  if (!leaseId) {
    throw new AgentWorkerError(`Agent run '${runId}' has no lease to run under.`)
  }
  const agents = storage.agents

  const history = await agents.messages.list({ projectId, threadId: run.threadId, order: "asc" })
  // `toModelMessages` is core's `ai`-free mirror of `convertToModelMessages`. The only type gap is
  // `providerOptions`, which core types as the wider `JsonValue` (it cannot depend on `ai`); the
  // values originate from the SDK, so the runtime shape is compatible. The worker is where `ai`
  // lives, so this single boundary cast belongs here. Locked by `tests/ai-sdk-compat.types.ts`.
  const modelMessages = toModelMessages(history.messages) as ModelMessage[]

  const maxSteps = agent.loop?.stopWhen?.maxSteps ?? defaultMaxSteps

  // The model call is aborted by worker shutdown, by the heartbeat detecting a lost lease, or by the
  // turn exceeding its wall-clock budget (a slow-but-alive model must not hold the thread forever).
  const heartbeatAbort = new AbortController()
  const timeoutAbort = new AbortController()
  let timedOut = false
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    timeoutAbort.abort()
  }, turnTimeoutMs)
  const abortSignal = AbortSignal.any([signal, heartbeatAbort.signal, timeoutAbort.signal])

  const result = streamText({
    model: agent.model,
    system: systemInstructions(agent.instructions, context.systemAddendum),
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal,
  })

  let responseMessage: AgentInboundLike | undefined
  const uiStream = result.toUIMessageStream({
    onFinish: (event) => {
      responseMessage = event.responseMessage
    },
  })

  let leaseLost = false
  const heartbeat = startLeaseHeartbeat({
    storage: agents,
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
  let chunkIndex = 0
  try {
    // Draining the UI stream drives the model loop and fires `onFinish`. Chunks are live UI state:
    // publish them to the broker stream, but keep durable messages final-only.
    for await (const chunk of uiStream) {
      await context.streamSink.publishUiChunk({
        run,
        chunkIndex: chunkIndex++,
        chunk,
      })
    }
  } catch (error) {
    drainError = error
  } finally {
    heartbeat.stop()
    clearTimeout(timeoutTimer)
  }

  if (leaseLost) {
    throw new AgentLeaseLostError(runId)
  }
  // A timeout aborts the stream, surfacing as `drainError`; check our flag first so a timed-out turn
  // throws the typed (non-abort) error and is recorded `failed` rather than treated as a shutdown.
  if (timedOut) {
    throw new AgentTurnTimeoutError(runId, turnTimeoutMs)
  }
  if (drainError !== undefined) {
    throw drainError
  }
  if (!responseMessage) {
    throw new AgentWorkerError(`Agent run '${runId}' produced no response message.`)
  }

  const assistant: AgentMessage = fromAiSdk(responseMessage)

  // One last renew right before we write: a successful renew proves we still hold the lease, and it
  // pushes expiry out by `leaseMs`, so the (lease-unfenced) message append cannot race a reclaim.
  await renewOrLost({ storage: agents, projectId, runId, leaseId, leaseMs })

  const usage = mapUsage(await result.totalUsage)
  const finishReason = await result.finishReason
  const assistantMessageId = createAgentMessageId()

  // The assistant append and run finish share one transaction, so redelivery cannot observe a
  // finalized message without the terminal run state that releases the thread. Transient blips are
  // retried in place.
  const finalizedRun = await appendMessageAndFinishRunOrThrow(storage, {
    message: {
      id: assistantMessageId,
      projectId,
      threadId: run.threadId,
      runId,
      role: assistant.role,
      parts: assistant.parts,
      ...(assistant.metadata === undefined ? {} : { metadata: assistant.metadata }),
      ...(run.executionPrincipal === undefined ? {} : { authorPrincipal: run.executionPrincipal }),
    },
    finish: {
      projectId,
      id: runId,
      leaseId,
      status: "succeeded",
      modelId: agent.model.modelId,
      finishReason,
      ...(usage === undefined ? {} : { usage }),
    },
  })

  await context.streamSink.publishMessageFinalized({
    run,
    messageId: assistantMessageId,
  })
  await context.streamSink.publishRunFinished(finalizedRun)

  return finalizedRun
}

function systemInstructions(instructions: string, addendum: string | undefined): string {
  const base = `${instructions.trimEnd()}\n\n${DEFAULT_SYSTEM_CONTEXT}`
  if (!addendum) {
    return base
  }
  return `${base}\n\n${addendum}`
}

// `toUIMessageStream`'s `onFinish` hands back the SDK `UIMessage`; `fromAiSdk` accepts the wider
// inbound shape. We keep the parameter loose here and let `fromAiSdk` narrow/validate at runtime.
type AgentInboundLike = Parameters<typeof fromAiSdk>[0]

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
      if (isTerminalOrLeaseGone(error)) {
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
    if (isTerminalOrLeaseGone(error)) {
      throw new AgentLeaseLostError(input.runId)
    }
    throw error
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
