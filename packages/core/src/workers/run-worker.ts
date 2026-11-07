import { withFailureMessage } from "../errors/internal"
import type { SixbErrorCode, SixbFailure } from "../errors/types"
import type { ClaimedQueueJob, QueueJob } from "../queues"
import { type BackoffPolicy, backoffDelay } from "../shared/backoff"
import type {
  ConfirmRunExecutionInput,
  ExecutionRecord,
  ExecutionStorage,
  ReleaseRunExecutionInput,
  RunClaim,
  RunExecution,
} from "../storage"
import type { QueueDelivery } from "./queue-delivery"
import {
  QueueWorker,
  type QueueWorkerConfig,
  type QueueWorkerFailureCodes,
  type QueueWorkerFailureDecision,
} from "./queue-worker"
import { projectRunLease } from "./run-lease"

/** A run a worker can lose and take up again: what the shared recovery reads of it. */
interface RecoverableRun<TFailureCode extends SixbErrorCode = SixbErrorCode> {
  readonly id: string
  readonly executionId: string
  readonly status: string
  readonly attempt: number
  readonly error?: SixbFailure<TFailureCode>
}

interface RunRecoveryStorage<TRun> {
  getById(params: { readonly projectId: string; readonly id: string }): Promise<TRun | null>
  confirmExecutionOwnership(input: ConfirmRunExecutionInput): Promise<unknown>
  releaseExecution(input: ReleaseRunExecutionInput): Promise<void>
}

export interface RunWorkerConfig<
  TJob extends RunQueueJob,
  TFailureCodes extends QueueWorkerFailureCodes,
  TRun,
> extends QueueWorkerConfig<TJob, TFailureCodes> {
  readonly runs: RunRecoveryStorage<TRun>
  /** Where a run's durable execution is read. */
  readonly executions: Pick<ExecutionStorage, "getById">
  /** How many executions a run gets. Defaults to five. */
  readonly maxAttempts?: number
}

/** A queue job that stands for a durable run. */
type RunQueueJob = QueueJob<string, { readonly runId: string }>

/**
 * A claim, or a run the job will take by a transition of its own, which `deferred` hands it
 * untaken: a workflow's resume, or a projection, whose job takes its run under the token made here.
 */
export type RunDelivery<TRun> =
  | RunClaim<TRun>
  | { readonly outcome: "deferred"; readonly run: TRun }

/** What an execution holds once a delivery has taken a run. */
export type HeldRunClaim<TRun> = Extract<
  RunDelivery<TRun>,
  { readonly outcome: "started" | "resumed" | "deferred" }
> & {
  readonly execution: RunExecution
  /**
   * Set when the run has no attempts left. The execution finishes what already happened, a commit
   * that landed above all, and ends the run with this instead of doing anything new.
   */
  readonly givenUp?: Error
}

/**
 * A delivery found its run held by a live execution: a duplicate job. It leaves the run alone and
 * comes back once that execution's lease runs out, so that a run whose execution dies keeps a job.
 */
export class RunOwnedElsewhereError extends Error {
  readonly name = "RunOwnedElsewhereError"

  constructor(
    readonly runId: string,
    readonly ownedUntil: Date
  ) {
    super(`[SixbQueueWorker] Run '${runId}' is still held by another delivery.`)
  }
}

/** A delivery found its run waiting for a sibling to end. It comes back later, as a safety net. */
class RunWaitingForSiblingError extends Error {
  readonly name = "RunWaitingForSiblingError"

  constructor(runId: string) {
    super(`[SixbQueueWorker] Run '${runId}' waits for a sibling to end.`)
  }
}

/** A run that resumed this many times without ending is not going to end by resuming. */
class RunAttemptsSpentError extends Error {
  readonly name = "RunAttemptsSpentError"

  constructor(runId: string, attempts: number) {
    super(`[SixbQueueWorker] Run '${runId}' was given up after ${attempts} attempts.`)
  }
}

function runAttemptsSpent(runId: string, attempts: number): Error {
  return withFailureMessage(
    new RunAttemptsSpentError(runId, attempts),
    `Its worker stopped ${attempts} times before it could finish.`
  )
}

const DEFAULT_MAX_ATTEMPTS = 5
/** Floor for a duplicate's deferral, so a skewed lease clock cannot make it redeliver at once. */
const OWNED_ELSEWHERE_MIN_DEFER_MS = 1_000
const RETRY_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 60_000 }
/**
 * A finished run wakes the run that waits for it. This is for when that word gets lost: a slow
 * look, once per job, and a job waiting behind a sibling costs nothing in between.
 */
const SIBLING_RECHECK_MS = 60_000

/**
 * A worker whose runs survive it. Every delivery claims the run first, so duplicates, stale jobs
 * and finished runs all stop here; the primitive supplies what to do with a run it holds. Recovery
 * is described in this folder's README.
 */
export abstract class RunWorker<
  TJob extends RunQueueJob,
  TFailureCodes extends QueueWorkerFailureCodes,
  TRun extends RecoverableRun<TFailureCodes[number]>,
> extends QueueWorker<TJob, TFailureCodes> {
  private readonly runs: RunRecoveryStorage<TRun>
  private readonly executions: RunWorkerConfig<TJob, TFailureCodes, TRun>["executions"]
  private readonly maxAttempts: number

  constructor(config: RunWorkerConfig<TJob, TFailureCodes, TRun>) {
    super(config)
    this.runs = config.runs
    this.executions = config.executions
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  }

  /** Run what is left of a run this delivery holds, and record how it ended. */
  protected abstract executeRun(
    claim: HeldRunClaim<TRun>,
    claimed: ClaimedQueueJob<TJob>,
    signal: AbortSignal
  ): Promise<void>

  /** Takes the run this job stands for, or says the job will, by a transition of its own. */
  protected abstract claimRun(
    claimed: ClaimedQueueJob<TJob>,
    execution: RunExecution
  ): Promise<RunDelivery<TRun>>

  /** The durable execution behind a run: a run with none has nothing to run under. */
  protected async requireExecution(run: TRun): Promise<ExecutionRecord> {
    const execution = await this.executions.getById({
      projectId: this.config.projectId,
      id: run.executionId,
    })
    if (execution) return execution

    throw new Error(
      `[SixbQueueWorker] Run '${run.id}' references missing execution '${run.executionId}'.`
    )
  }

  /** When a run that could not finish gets its next delivery. */
  protected nextRetryAt(claimed: ClaimedQueueJob<TJob>): string {
    const delayMs = backoffDelay(Math.max(claimed.job.attempt - 1, 0), RETRY_BACKOFF)

    return new Date(Date.now() + delayMs).toISOString()
  }

  protected async execute(
    claimed: ClaimedQueueJob<TJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<TJob, TFailureCodes[number]>
  ): Promise<void> {
    const execution = freshRunExecution(delivery.leaseExpiresAt)
    const claim = await this.claimRun(claimed, execution)

    if (claim.outcome === "settled") return
    if (claim.outcome === "held") throw new RunOwnedElsewhereError(claim.run.id, claim.ownedUntil)

    if (claim.outcome === "waiting") throw new RunWaitingForSiblingError(claim.run.id)

    const stopProjectingLease = projectRunLease(delivery, this.runs, {
      projectId: this.config.projectId,
      id: claim.run.id,
      executionToken: execution.token,
    })

    try {
      await this.executeRun(
        {
          ...claim,
          execution,
          ...(claim.run.attempt > this.maxAttempts
            ? { givenUp: runAttemptsSpent(claim.run.id, this.maxAttempts) }
            : {}),
        },
        claimed,
        signal
      )
    } catch (error) {
      if (delivery.state !== "lost") await this.handBack(claim.run.id, execution, signal)
      throw error
    } finally {
      stopProjectingLease()
    }
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<TJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<TFailureCodes[number]>> {
    const deferred = deferredDecision(error)
    if (deferred) return deferred

    const run = await this.runs.getById({
      projectId: this.config.projectId,
      id: claimed.job.payload.runId,
    })

    // Not over yet: this delivery could not take the run, or record how it ended, and the next one
    // can find out. It is the run's attempts that bound this, never how often its job came round.
    if (run?.status === "queued" || run?.status === "running") {
      return { kind: "retry", availableAt: this.nextRetryAt(claimed) }
    }

    return settledRunDecision(run)
  }

  protected override async onAbortError(
    claimed: ClaimedQueueJob<TJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<TFailureCodes[number]>> {
    const deferred = deferredDecision(error)
    if (deferred) return deferred

    const run = await this.runs.getById({
      projectId: this.config.projectId,
      id: claimed.job.payload.runId,
    })

    if (run?.status === "queued" || run?.status === "running") return { kind: "retry" }

    return settledRunDecision(run)
  }

  /**
   * Gives up holding the run, so the job that comes back does not wait out this execution's lease.
   * A worker that was stopped spent nothing; an attempt that failed did. Storage ignores this once
   * the run has ended or moved on. If this write is lost, the lease simply runs out.
   */
  private async handBack(
    runId: string,
    execution: RunExecution,
    signal: AbortSignal
  ): Promise<void> {
    await this.runs
      .releaseExecution({
        projectId: this.config.projectId,
        id: runId,
        executionToken: execution.token,
        spentAttempt: !signal.aborted,
      })
      .catch((error) => {
        console.error(`[SixbQueueWorker] Could not hand back run '${runId}'.`, error)
      })
  }
}

function deferredDecision(
  error: unknown
): Extract<QueueWorkerFailureDecision, { readonly kind: "retry" }> | undefined {
  if (error instanceof RunOwnedElsewhereError) return retryOnceReleased(error)

  if (error instanceof RunWaitingForSiblingError) {
    return { kind: "retry", availableAt: new Date(Date.now() + SIBLING_RECHECK_MS).toISOString() }
  }

  return undefined
}

function freshRunExecution(queueLeaseExpiresAt: string): RunExecution {
  return {
    token: `runx_${crypto.randomUUID()}`,
    queueLeaseExpiresAt: new Date(queueLeaseExpiresAt),
  }
}

/** Bring a duplicate job back once the execution that holds its run has lost that hold. */
export function retryOnceReleased(
  error: RunOwnedElsewhereError
): Extract<QueueWorkerFailureDecision, { readonly kind: "retry" }> {
  const availableAt = Math.max(
    error.ownedUntil.getTime(),
    Date.now() + OWNED_ELSEWHERE_MIN_DEFER_MS
  )

  return { kind: "retry", availableAt: new Date(availableAt).toISOString() }
}

function settledRunDecision<TFailureCode extends SixbErrorCode>(
  run: RecoverableRun<TFailureCode> | null
): QueueWorkerFailureDecision<TFailureCode> {
  return run?.error ? { kind: "fail", failure: run.error } : { kind: "fail" }
}
