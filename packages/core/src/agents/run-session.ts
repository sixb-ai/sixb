import type { Broker } from "../broker"
import {
  AiModelCallRecorder,
  createAiModelCallLimitController,
  type ModelCallAccountingStorage,
  type RecoverAiModelCall,
} from "../models/execution/index"
import type { Storage } from "../storage"
import {
  type AgentRunRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadSandboxState,
  type AppendAgentMessageInput,
  type FinishAgentRunInput,
  type TransitionAgentThreadSandboxInput,
} from "../storage/agents"
import { turnPausesOnHeldCalls } from "./approvals"
import { createAgentRunExecutionToken } from "./ids"
import type { StreamSink } from "./run-events"
import {
  type AgentRunChildren,
  type AgentRunChildrenHost,
  type AgentRunMail,
  agentRunChildren,
  agentRunMail,
} from "./run-session-children"
import { subscribeAgentRunCancel } from "./streams/protocol"

/**
 * A run's session: the one way its runner reads and writes shared state for it. Claiming the run
 * creates it, with a fresh execution token, and every write it makes is fenced by that token: once
 * another delivery reclaims the run, this session's writes fail with
 * {@link AgentExecutionLostError} and the runner stops touching the run.
 *
 * The worker uses an in-process session. A runner elsewhere will reach the same operations over
 * HTTP, so nothing here may assume it shares a process with storage.
 */
export interface AgentRunSession<TRun extends AgentRunRecord = AgentRunRecord> {
  /** The run as the claim left it: `running`, with this session's execution. */
  readonly run: TRun
  readonly executionToken: string
  /** Aborts once the run, or any run named in `cancelWith`, is cancelled. */
  readonly cancelled: AbortSignal
  /**
   * The run's model calls. Wrap a model with it, and each call is admitted against the AI limits
   * of whoever the run works for, and its usage and cost recorded before the next step; a record
   * that cannot be written is recovered later. Project tools' own model calls bill here too.
   *
   * The first call reads what admission needs, so it belongs in the run's preparation, where a
   * storage blip is retried: a failed read is read again on the next call.
   */
  modelCalls(): Promise<AiModelCallRecorder>
  /**
   * Live records for whoever watches the run: its start, chunks, compaction, finalized message and
   * end. Best effort: a record that cannot be delivered never fails the run, whose finish is the
   * durable record.
   */
  readonly events: StreamSink
  /** Approvals that hold the run: they are created by the API its commands call, never here. */
  readonly heldCalls: AgentRunHeldCalls
  /** A conversation turn's children: spawning them, and reading them and their threads. */
  readonly children: AgentRunChildren
  /** Mail between a turn and its children. */
  readonly mail: AgentRunMail
  /**
   * Record that the runner still holds the run until `leaseExpiresAt`. A run token fails closed
   * once the last lease recorded lapses, so the session renews it as the queue does.
   */
  renewLease(leaseExpiresAt: string): Promise<void>
  /**
   * End the run, with what it did appended first in the same transaction. Absorbs a transient
   * storage failure with a few short retries; see {@link AgentExecutionLostError} and
   * {@link AgentFinalizationError} for what it throws.
   */
  finish(
    outcome: AgentRunOutcome,
    messages?: readonly AppendAgentMessageInput[]
  ): Promise<AgentRunRecord>
  /**
   * Throws {@link AgentExecutionLostError} unless the run still runs under this session, within
   * its lease. Run it right before a side effect the run must not make once another delivery owns
   * it.
   */
  assertOwned(): Promise<void>
  /** A conversation's persistent workspace, as this run holds it. */
  readonly workspace: AgentRunWorkspace
  /** Stop watching for cancellation. The run itself is unaffected. */
  close(): void
}

/** A thread's persistent workspace state, moved only by the run that holds the thread. */
export interface AgentRunWorkspace {
  /** Acquire, replace or settle the thread's workspace; refused once the run lost its execution. */
  transition(input: AgentRunWorkspaceTransition): Promise<AgentThreadSandboxState>
}

/** A workspace transition a run makes; the session adds which run, and its token. */
export type AgentRunWorkspaceTransition = TransitionAgentThreadSandboxInput extends infer T
  ? T extends { readonly runId: string }
    ? Omit<T, "projectId" | "runId" | "executionToken">
    : never
  : never

export interface AgentRunHeldCalls {
  /** Whether a call of this run, or of one of its children, waits for an approval. */
  holdsRun(): Promise<boolean>
  /**
   * Whether a conversation turn pauses after the step it just took: a call of its own is held, or
   * a child's is and no child is still at work.
   */
  pausesAfterStep(): Promise<boolean>
}

/** How a run ended; the session supplies which run, and its token. */
export type AgentRunOutcome = FinishAgentRunInput extends infer Finish
  ? Finish extends FinishAgentRunInput
    ? Omit<Finish, "projectId" | "id" | "executionToken">
    : never
  : never

/** What an in-process session works against. */
export interface AgentRunSessionHost extends AgentRunChildrenHost {
  readonly projectId: string
  readonly storage: Storage & { readonly agents: AgentStorage } & ModelCallAccountingStorage
  readonly broker: Broker
  /** Queues a model call's record when storage cannot take it while the run goes on. */
  readonly recoverAiModelCall: RecoverAiModelCall
  /** Where live records go; the host keeps them best effort (see isolateStreamSink). */
  readonly events: StreamSink
}

export interface ClaimAgentRunInput<TRun extends AgentRunRecord> {
  /** A queued run, or a running one whose last delivery's lease lapsed. */
  readonly run: TRun
  readonly modelId?: string
  /** When the queue delivery that claims the run expires unless renewed. */
  readonly leaseExpiresAt: string
  /** Other runs whose cancellation cancels this one: a child's parent. */
  readonly cancelWith?: readonly string[]
}

/**
 * Start a queued run, or reclaim a running one, and open its session. Returns null when the run
 * ended meanwhile, so there is nothing to claim.
 */
export async function claimAgentRun<TRun extends AgentRunRecord>(
  host: AgentRunSessionHost,
  input: ClaimAgentRunInput<TRun>
): Promise<AgentRunSession<TRun> | null> {
  const run = await startOrReclaim(host.storage.agents, host.projectId, input)
  if (!run) return null
  return openAgentRunSession(host, run, input.cancelWith)
}

/**
 * The session of a run already claimed: the one its execution token names. A server answering a
 * remote runner opens it per request; the worker opens it once, when it claims the run.
 */
export async function openAgentRunSession<TRun extends AgentRunRecord>(
  host: AgentRunSessionHost,
  run: TRun,
  cancelWith: readonly string[] = []
): Promise<AgentRunSession<TRun>> {
  const executionToken = run.execution?.token
  if (!executionToken) {
    throw new Error(`[Sixb] Agent run '${run.id}' has no execution token, so it was never claimed.`)
  }

  let modelCalls: Promise<AiModelCallRecorder> | undefined
  const cancel = await watchAgentRunCancel(host, [run.id, ...cancelWith])
  const fence = { projectId: host.projectId, id: run.id, executionToken }

  return {
    run,
    executionToken,
    cancelled: cancel.signal,
    events: host.events,
    children: agentRunChildren(host, run, executionToken),
    mail: agentRunMail(host),
    heldCalls: {
      holdsRun: () =>
        host.storage.agents.approvals.holdsRun({ projectId: host.projectId, runId: run.id }),
      pausesAfterStep: () => turnPausesOnHeldCalls(host.storage.agents, run),
    },
    modelCalls() {
      modelCalls ??= openModelCalls(host, run).catch((error: unknown) => {
        modelCalls = undefined
        throw error
      })
      return modelCalls
    },
    async renewLease(leaseExpiresAt) {
      await host.storage.agents.runs.confirmExecutionOwnership({
        ...fence,
        queueLeaseExpiresAt: new Date(leaseExpiresAt),
      })
    },
    finish: (outcome, messages) =>
      finishWithRetries(host.storage, { ...outcome, ...fence }, messages ?? []),
    async assertOwned() {
      const current = await host.storage.agents.runs.getById({
        projectId: host.projectId,
        id: run.id,
      })
      if (
        current?.status !== "running" ||
        current.execution?.token !== executionToken ||
        current.execution.queueLeaseExpiresAt.getTime() <= Date.now()
      ) {
        throw new AgentExecutionLostError(run.id)
      }
    },
    workspace: {
      transition: (input) =>
        host.storage.agents.threads.transitionSandbox({
          ...input,
          projectId: host.projectId,
          runId: run.id,
          executionToken,
        }),
    },
    close: cancel.stop,
  }
}

async function openModelCalls(
  host: AgentRunSessionHost,
  run: AgentRunRecord
): Promise<AiModelCallRecorder> {
  const execution = await host.storage.executions.getById({
    projectId: host.projectId,
    id: run.executionId,
  })
  if (!execution) {
    throw new Error(
      `[Sixb] Agent run '${run.id}' references missing execution '${run.executionId}'.`
    )
  }
  return new AiModelCallRecorder({
    storage: host.storage,
    projectId: host.projectId,
    executionId: run.executionId,
    attempt: run.attempt,
    requesterGroupIds: execution.requesterGroupIds,
    limits: createAiModelCallLimitController({
      storage: host.storage,
      projectId: host.projectId,
      requestedBy: execution.requestedBy,
      requesterGroupIds: execution.requesterGroupIds,
    }),
    recoverAiModelCall: host.recoverAiModelCall,
  })
}

/**
 * Watch runs for a cancel, best effort: failing to attach a watch costs that run its
 * cancellability, never the run itself. `stop` unsubscribes.
 */
export async function watchAgentRunCancel(
  host: Pick<AgentRunSessionHost, "projectId" | "broker">,
  runIds: readonly string[]
): Promise<{ readonly signal: AbortSignal; readonly stop: () => void }> {
  const controller = new AbortController()
  const unsubscribes = await Promise.all(
    runIds.map((runId) =>
      subscribeAgentRunCancel(host.broker, { projectId: host.projectId, runId }, () =>
        controller.abort()
      ).catch((error: unknown) => {
        console.error(`[Sixb] Agent run '${runId}' cancel watch failed to start:`, error)
        return undefined
      })
    )
  )
  return {
    signal: controller.signal,
    stop: () => {
      for (const unsubscribe of unsubscribes) unsubscribe?.()
    },
  }
}

/** This session's execution token is stale, so it must make no further durable writes. */
export class AgentExecutionLostError extends Error {
  readonly name = "AgentExecutionLostError"
  constructor(readonly runId: string) {
    super(`[Sixb] Lost execution ownership of agent run '${runId}'.`)
  }
}

/**
 * The run's end could not be recorded: storage stayed unavailable across the retries. The runner
 * leaves the delivery for another attempt rather than acknowledging a run that never ended.
 */
export class AgentFinalizationError extends Error {
  readonly name = "AgentFinalizationError"
  constructor(
    readonly runId: string,
    options?: ErrorOptions
  ) {
    super(`[Sixb] Could not finalize agent execution '${runId}'; storage is unavailable.`, options)
  }
}

/**
 * Storage outcomes that mean the run is no longer this session's: another delivery owns it, or it
 * already ended. There is nothing more to record either way.
 */
export function isTerminalOrExecutionGone(error: unknown): boolean {
  return (
    error instanceof AgentStorageError &&
    (error.code === "execution_lost" ||
      error.code === "invalid_state" ||
      error.code === "run_not_found")
  )
}

async function startOrReclaim<TRun extends AgentRunRecord>(
  agents: AgentStorage,
  projectId: string,
  input: ClaimAgentRunInput<TRun>
): Promise<TRun | null> {
  const { run } = input
  const execution = {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: new Date(input.leaseExpiresAt),
  }
  if (run.status !== "queued" && run.status !== "running") return null
  // The read the caller made is already old: a run that ended since, or that another worker
  // started, is not this caller's.
  try {
    return run.status === "queued"
      ? sameKind(
          run,
          await agents.runs.start({ projectId, id: run.id, modelId: input.modelId, execution }),
          "starting"
        )
      : sameKind(run, await agents.runs.reclaim({ projectId, id: run.id, execution }), "reclaiming")
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "invalid_state") return null
    throw error
  }
}

function sameKind<TRun extends AgentRunRecord>(
  run: TRun,
  claimed: AgentRunRecord,
  while_: string
): TRun {
  if (claimed.kind !== run.kind) {
    throw new Error(`[Sixb] Agent run '${run.id}' changed kind while ${while_}.`)
  }
  return claimed as TRun
}

/** Short in-place retries that absorb a transient storage blip without re-running the model. */
const FINISH_BACKOFF_MS = [50, 200, 600] as const

async function finishWithRetries(
  storage: AgentRunSessionHost["storage"],
  finish: FinishAgentRunInput,
  messages: readonly AppendAgentMessageInput[]
): Promise<AgentRunRecord> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (messages.length === 0) return await storage.agents.runs.finish(finish)
      return await storage.transaction(async (tx) => {
        const agents = tx.agents
        if (!agents) throw new Error("[Sixb] Agent storage is not configured.")
        for (const message of messages) await agents.messages.append(message)
        return agents.runs.finish(finish)
      })
    } catch (error) {
      if (isTerminalOrExecutionGone(error)) throw new AgentExecutionLostError(finish.id)
      const delay = FINISH_BACKOFF_MS[attempt]
      if (delay === undefined) throw new AgentFinalizationError(finish.id, { cause: error })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
