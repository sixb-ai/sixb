/**
 * Who holds a running run: the token that fences every write to it, and until when the queue lease
 * behind that token is known to last.
 */
export interface RunExecution {
  readonly token: string
  readonly queueLeaseExpiresAt: Date
}

/**
 * A run from before runs held a lease shows nothing that says whether a worker still has it. It is
 * left alone for this long, far past what a deploy takes to replace its workers, and then counts
 * as lost. A longer run on a worker of that older version would be lost with it.
 */
export const ORPHANED_RUN_AFTER_MS = 24 * 60 * 60_000

export interface ClaimRunInput {
  readonly projectId: string
  readonly id: string
  /** The execution that takes the run, when the run can be taken. */
  readonly execution: RunExecution
  /** Defaults to now. */
  readonly claimedAt?: Date
}

/**
 * What a delivery found. `started` and `resumed` hand it the run. `held` means a live execution has
 * it until `ownedUntil`, so this delivery is a duplicate. `waiting` means the run has not started
 * and cannot until `sibling` ends. `settled` means nothing is left to do.
 */
export type RunClaim<TRun> =
  | { readonly outcome: "started" | "resumed"; readonly run: TRun }
  | { readonly outcome: "held"; readonly run: TRun; readonly ownedUntil: Date }
  | { readonly outcome: "waiting"; readonly run: TRun; readonly sibling: ClaimableRun }
  | { readonly outcome: "settled"; readonly run: TRun }

export interface ConfirmRunExecutionInput {
  readonly projectId: string
  readonly id: string
  readonly executionToken: string
  readonly queueLeaseExpiresAt: Date
}

export interface ReleaseRunExecutionInput {
  readonly projectId: string
  readonly id: string
  readonly executionToken: string
  /**
   * False hands the run back as if this execution had not happened: a deploy stopping a worker
   * must not use up the attempts a run has against crashes and failures.
   */
  readonly spentAttempt: boolean
  /** Defaults to now. */
  readonly releasedAt?: Date
}

/**
 * What the recovery pass asks a store: the runs no delivery can be counted on to reach. Stores answer
 * from their status index, so a project with nothing lost reads no rows, however many runs it keeps.
 */
export interface ListLostRunsInput {
  readonly projectId: string
  /** Older than this, a queued run's job should have started it. */
  readonly queuedBefore: Date
  /** A running run whose lease ended by this has lost its execution. */
  readonly lapsedBy: Date
  /** A running run with no lease, started before this, belongs to an older version that is gone. */
  readonly orphanedBefore: Date
  readonly limit: number
}

export interface ClaimableRun {
  readonly id: string
  readonly status: string
  readonly startedAt?: Date
  readonly attempt: number
  readonly execution?: RunExecution
}

export type RunClaimPlan<TRun> =
  | {
      readonly take: true
      readonly outcome: "started" | "resumed"
      readonly startedAt: Date
      readonly attempt: number
      readonly execution: RunExecution
    }
  | { readonly take: false; readonly claim: RunClaim<TRun> }

/** Until when an execution may be holding a running run. */
function runHeldUntil(run: ClaimableRun): Date | undefined {
  if (run.execution) return run.execution.queueLeaseExpiresAt
  return run.startedAt && new Date(run.startedAt.getTime() + ORPHANED_RUN_AFTER_MS)
}

/**
 * Whether a running run has no execution, and has not for long enough to be lost. Every execution
 * leaves one on the run, and a hand-back only lets its lease lapse, so this is an older version's.
 */
export function isOrphanedRun(run: ClaimableRun, now: Date): boolean {
  const heldUntil = runHeldUntil(run)
  return (
    run.status === "running" &&
    run.execution === undefined &&
    heldUntil !== undefined &&
    heldUntil.getTime() <= now.getTime()
  )
}

/** Whether a lease a run shows has lapsed, so that it takes a delivery to go on. */
export function hasLapsedLease(run: ClaimableRun, now: Date): boolean {
  return (
    run.status === "running" &&
    run.execution !== undefined &&
    run.execution.queueLeaseExpiresAt.getTime() <= now.getTime()
  )
}

/**
 * The one decision every delivery of a run makes, in the transaction that holds the run: `queued`
 * starts, `running` resumes under a new token once nothing holds it, and anything else is over. A
 * run keeps the time it first started across resumes. An orphaned run is not resumed: nothing says
 * what its old worker did, so only the recovery pass ends it.
 *
 * `sibling` is a run this one must not overlap. It waits for that run to end, and a trigger that
 * arrives meanwhile joins it, since it has not started.
 */
export function planRunClaim<TRun extends ClaimableRun>(
  run: TRun,
  input: Pick<ClaimRunInput, "execution" | "claimedAt">,
  sibling?: ClaimableRun
): RunClaimPlan<TRun> {
  const now = input.claimedAt ?? new Date()

  if ((run.status !== "queued" && run.status !== "running") || isOrphanedRun(run, now)) {
    return { take: false, claim: { outcome: "settled", run } }
  }

  if (run.status === "queued" && sibling && !isOrphanedRun(sibling, now)) {
    return { take: false, claim: { outcome: "waiting", run, sibling } }
  }

  const heldUntil = runHeldUntil(run)
  if (run.status === "running" && heldUntil && heldUntil.getTime() > now.getTime()) {
    return { take: false, claim: { outcome: "held", run, ownedUntil: heldUntil } }
  }

  return {
    take: true,
    outcome: run.status === "queued" ? "started" : "resumed",
    startedAt: run.status === "queued" ? now : (run.startedAt ?? now),
    attempt: run.attempt + 1,
    execution: input.execution,
  }
}

type LostRunCandidate = ClaimableRun & {
  readonly projectId: string
  readonly queuedAt?: Date
}

/**
 * `listLost`, over rows held in memory. Running runs come first, longest lost first: a queued run
 * may only be waiting for its sibling, and however many of those there are, they must not keep a
 * lost run from being looked at. Stores that query say the same in their own language.
 */
export function selectLostRuns<TRun extends LostRunCandidate>(
  runs: Iterable<TRun>,
  input: ListLostRunsInput
): readonly TRun[] {
  return [...runs]
    .filter((run) => run.projectId === input.projectId && isLostRun(run, input))
    .sort(
      (left, right) =>
        Number(right.status === "running") - Number(left.status === "running") ||
        lostSince(left) - lostSince(right)
    )
    .slice(0, input.limit)
}

function isLostRun(run: LostRunCandidate, input: ListLostRunsInput): boolean {
  if (run.status === "queued") {
    return run.queuedAt !== undefined && run.queuedAt.getTime() <= input.queuedBefore.getTime()
  }
  if (run.status !== "running") return false

  if (run.execution) return run.execution.queueLeaseExpiresAt.getTime() <= input.lapsedBy.getTime()

  return run.startedAt !== undefined && run.startedAt.getTime() <= input.orphanedBefore.getTime()
}

function lostSince(run: LostRunCandidate): number {
  return (run.execution?.queueLeaseExpiresAt ?? run.startedAt ?? run.queuedAt ?? 0).valueOf()
}

/** A lease only moves forward: confirmations can race, and the latest one must win. */
export function laterLease(current: Date | undefined, next: Date): Date {
  return current && current.getTime() > next.getTime() ? current : next
}

/**
 * Only the execution that holds a run may write to it. A write with no token comes from outside any
 * execution, so it needs a run nothing holds. `now` is when the write happens.
 */
export function holdsRun(
  run: Pick<ClaimableRun, "execution">,
  token: string | undefined,
  now: Date = new Date()
): boolean {
  if (token !== undefined) return run.execution?.token === token
  return !run.execution || run.execution.queueLeaseExpiresAt.getTime() <= now.getTime()
}

/** A cancel with no token comes from outside, and ends the run for whichever execution holds it. */
export function mayFinishRun(
  run: Pick<ClaimableRun, "execution">,
  input: { readonly status: string; readonly executionToken?: string }
): boolean {
  if (input.status === "cancelled" && input.executionToken === undefined) return true
  return holdsRun(run, input.executionToken)
}
