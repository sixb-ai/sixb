import {
  type AgentRunFailure,
  agentRunFailureDetails,
  ChildRunner,
  type ChildRunnerHost,
  toAgentRunFailure,
} from "@sixb/agent"
import {
  type AgentRunSession,
  type AgentRunSessionHost,
  claimAgentRun,
  isTerminalOrExecutionGone,
} from "@sixb/core/internal/agents"
import type { AgentRunRecord, SubagentRunRecord } from "@sixb/core/storage"
import { isPermanentAgentPreparationError } from "./delivery-policy"
import {
  PREPARATION_RETRY_BACKOFF_MS,
  PRESTART_RETRY_BACKOFF_MS,
  retryPreparationInPlace,
  waitForAbort,
} from "./run-fate"
import { childSandbox } from "./run-sandboxes"
import type { AgentRunnerContext, AgentWorkerContext } from "./types"

/** What the worker lends its child runner. */
export interface WorkerChildrenDeps {
  readonly context: AgentWorkerContext
  readonly sessions: AgentRunSessionHost
  readonly settings: ChildRunnerHost["settings"]
  readonly capacity: number
  /** A child's context with what the worker's sandboxes need besides. */
  runnerContext(child: Parameters<ChildRunnerHost["openSandbox"]>[0]): Promise<AgentRunnerContext>
  trackTeardown(teardown: Promise<void>): void
  reportFailure(error: unknown, run: AgentRunRecord, failure: AgentRunFailure): void
}

/**
 * The worker's children: claimed in process, each in a sandbox from the project's factory, or its
 * thread's workspace when the factory keeps them.
 */
export function workerChildren(deps: WorkerChildrenDeps): ChildRunner {
  return new ChildRunner({
    settings: deps.settings,
    capacity: deps.capacity,
    claim: (run, claim) => claimChild(deps, run, claim),
    openSandbox: (child) => async (lifecycle) =>
      childSandbox({
        context: await deps.runnerContext(child),
        session: child.session,
        run: child.session.run,
        thread: child.thread,
      })(lifecycle),
    onDetachedTeardown: (teardown) => deps.trackTeardown(teardown),
    reportFailure: (error, run, failure) => deps.reportFailure(error, run, failure),
    // A storage blip while it prepares is retried in place.
    prepare: (prepare, signal) => retryPreparationInPlace(1, signal, prepare),
  })
}

/**
 * Claim a queued child, retrying for as long as its parent runs. One its claim refuses for good
 * ends failed, so its parent's wait returns. Once the parent ends, the repair pass ends a child
 * still queued.
 */
async function claimChild(
  deps: WorkerChildrenDeps,
  queuedRun: SubagentRunRecord,
  { leaseExpiresAt, stop }: { readonly leaseExpiresAt: string; readonly stop: AbortSignal }
): Promise<AgentRunSession<SubagentRunRecord> | null> {
  let refused: unknown
  for (let retry = 0; ; retry += 1) {
    try {
      if (refused !== undefined) {
        await failQueued(deps, queuedRun, refused)
        return null
      }
      return await claimAgentRun(deps.sessions, {
        run: queuedRun,
        modelId: queuedRun.spec.model.modelId,
        leaseExpiresAt,
        cancelWith: [queuedRun.parentRunId],
        stop,
      })
    } catch (error) {
      if (stop.aborted || isTerminalOrExecutionGone(error)) return null
      if (refused === undefined && isPermanentAgentPreparationError(error)) {
        refused = error
        continue
      }
      if (retry === 0) {
        console.error(
          `[SixbAgentWorker] Could not claim subagent run '${queuedRun.id}'; retrying while its parent runs.`,
          error
        )
      }
    }
    await waitForAbort(PREPARATION_RETRY_BACKOFF_MS[retry] ?? PRESTART_RETRY_BACKOFF_MS, stop)
    if (stop.aborted) return null
  }
}

async function failQueued(
  deps: WorkerChildrenDeps,
  run: SubagentRunRecord,
  error: unknown
): Promise<void> {
  const { context } = deps
  const completedAt = new Date()
  const failure = toAgentRunFailure(error, {
    status: "failed",
    at: completedAt,
    details: agentRunFailureDetails(run),
  })
  const failed = await context.storage.agents.runs.finishQueued({
    projectId: context.id,
    id: run.id,
    status: "failed",
    error: failure,
    completedAt,
  })
  deps.reportFailure(error, failed, failure)
  await context.streamSink.publishRunFinished(failed)
}
