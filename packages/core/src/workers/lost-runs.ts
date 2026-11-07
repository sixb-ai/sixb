import { captureSixbFailure, withFailureMessage } from "../errors/internal"
import type { SixbFailure } from "../errors/types"
import type { DomainEventLog, EventsAppendInput } from "../events/service"
import type { Queues } from "../queues"
import type { ListLostRunsInput, Storage } from "../storage"
import {
  type ClaimableRun,
  isOrphanedRun,
  isStaleRun,
  ORPHANED_RUN_AFTER_MS,
} from "../storage/run-claim"
import { recoverJobId } from "./job-ids"
import { type ProjectionRunRecovery, republishQueuedProjectionRuns } from "./lost-projection-runs"

/**
 * A job may still be on its way for this long: a queued run may be in its first publication, and a
 * run handed back has its job back in the queue.
 */
const JOB_ON_ITS_WAY_MS = 30_000
const DEFAULT_LIMIT = 100

/** Most runs of each primitive `countLostRuns` says it found. */
const COUNT_LIMIT = 1_000

const SOURCE = "SixbRunRecovery"
const LOST_WORKER = "Its worker was lost, and it was too old or too unclear to resume."

export interface RepublishLostRunsInput {
  readonly projectId: string
  readonly storage: Pick<
    Storage,
    "executions" | "syncRuns" | "pipelineRuns" | "workflowRuns" | "projectionRuns"
  >
  readonly queues: Pick<Queues, "syncRuns" | "pipelines" | "workflows" | "projections">
  readonly events: Pick<DomainEventLog, "emit">
  readonly now: Date
  /** Most runs of each primitive one call looks at, longest lost first. */
  readonly limit?: number
  /** Brings back queued projection runs. Without it, only lapsed ones get a job. */
  readonly projections?: ProjectionRunRecovery
  /** Stops a backlog of queued projection runs, which no limit caps, between two of them. */
  readonly signal?: AbortSignal
}

interface RepublishLostRunsResult {
  /** Jobs published for runs that had none. */
  readonly republished: number
  /** Runs given up on, which end `cancelled`. */
  readonly settled: number
}

/** What the next `runs` pass would do with one primitive's lost runs. */
export interface LostRunCount {
  readonly primitive: "sync" | "pipeline" | "workflow"
  /** They get a job, and run: a workflow's side effects with them. */
  readonly goOn: number
  /** They end `cancelled`. */
  readonly end: number
}

interface LostRunCandidate extends ClaimableRun {
  readonly executionId: string
  readonly queuedAt?: Date
}

type LostRunFailure = SixbFailure<"runtime.cancelled">

/** What differs between the primitives this pass looks after. */
interface RunLane<TRun extends LostRunCandidate> {
  readonly primitive: LostRunCount["primitive"]
  listLost(input: Omit<ListLostRunsInput, "projectId">): Promise<readonly TRun[]>
  enqueue(jobs: readonly RecoveryJob[]): Promise<unknown>
  /** End what the run left running, its steps or its nodes. */
  cancelChildren?(run: TRun, failure: LostRunFailure): Promise<void>
  cancel(run: TRun, failure: LostRunFailure): Promise<EventsAppendInput["events"][number]>
}

interface RecoveryJob {
  readonly id: string
  readonly runId: string
}

/**
 * What keeps a run from staying unfinished for good, for syncs, pipelines and workflows:
 *
 * - A queued run whose job never made it, or was lost with the queue, gets a job.
 * - A running run whose lease lapsed, which covers one handed back, gets a job.
 * - A running run with no lease, from a version that held none, is given time to end on its old
 *   worker, then ends `cancelled`. A cancelled run does not count as having read its inputs, so
 *   the triggers that were waiting on it fire again.
 * - A run lost for a week ends `cancelled` too, whatever it was: nothing it was asked for should
 *   happen by surprise that late, least of all a workflow's side effects.
 *
 * A delivery that finds the run held or finished does nothing, so this can be wrong about a job
 * being lost without doing harm. Projections have no older version to settle, and retry without a
 * cap, so a lost one only ever gets a job (see `republishQueuedProjectionRuns`).
 */
export async function republishLostRuns(
  input: RepublishLostRunsInput
): Promise<RepublishLostRunsResult> {
  const lanes = [
    recoverLane(input, syncLane(input)),
    recoverLane(input, pipelineLane(input)),
    recoverLane(input, workflowLane(input)),
    recoverProjections(input),
  ]

  // A lane that fails must not hold the others, and still has to reach the caller.
  const settled = await Promise.allSettled(lanes)

  const failed = settled.find((result) => result.status === "rejected")
  if (failed?.status === "rejected") throw failed.reason

  return settled.reduce<RepublishLostRunsResult>(
    (total, result) =>
      result.status === "fulfilled"
        ? {
            republished: total.republished + result.value.republished,
            settled: total.settled + result.value.settled,
          }
        : total,
    { republished: 0, settled: 0 }
  )
}

/** What the next pass would do, for someone about to start one. Nothing moves. */
export async function countLostRuns(
  input: Omit<RepublishLostRunsInput, "limit">
): Promise<readonly LostRunCount[]> {
  const counts = await Promise.all([
    countLane(input, syncLane(input)),
    countLane(input, pipelineLane(input)),
    countLane(input, workflowLane(input)),
  ])

  return counts.filter((count) => count !== null)
}

async function countLane<TRun extends LostRunCandidate>(
  input: Pick<RepublishLostRunsInput, "now">,
  lane: RunLane<TRun> | undefined
): Promise<LostRunCount | null> {
  if (!lane) return null

  const lost = await listLostRuns(input, lane, COUNT_LIMIT)
  const end = lost.filter((run) => isBeyondRecovery(run, input.now)).length

  return { primitive: lane.primitive, goOn: lost.length - end, end }
}

function listLostRuns<TRun extends LostRunCandidate>(
  { now }: Pick<RepublishLostRunsInput, "now">,
  lane: RunLane<TRun>,
  limit: number
): Promise<readonly TRun[]> {
  const jobOnItsWay = new Date(now.getTime() - JOB_ON_ITS_WAY_MS)

  return lane.listLost({
    queuedBefore: jobOnItsWay,
    lapsedBy: jobOnItsWay,
    orphanedBefore: new Date(now.getTime() - ORPHANED_RUN_AFTER_MS),
    limit,
  })
}

function isBeyondRecovery(run: LostRunCandidate, now: Date): boolean {
  return isOrphanedRun(run, now) || isStaleRun(run, now)
}

async function recoverLane<TRun extends LostRunCandidate>(
  input: RepublishLostRunsInput,
  lane: RunLane<TRun> | undefined
): Promise<RepublishLostRunsResult> {
  if (!lane) return { republished: 0, settled: 0 }

  const { now } = input
  const lost = await listLostRuns(input, lane, input.limit ?? DEFAULT_LIMIT)

  const beyondRecovery = lost.filter((run) => isBeyondRecovery(run, now))
  const failures: unknown[] = []

  // One run that cannot be ended must not keep the next pass from the others.
  for (const run of beyondRecovery) {
    await settleRun(input, lane, run).catch((error) => failures.push(error))
  }

  const jobs = lost.filter((run) => !isBeyondRecovery(run, now)).map(recoveryJob)

  if (jobs.length > 0) await lane.enqueue(jobs)
  if (failures.length > 0) {
    throw new AggregateError(failures, "[Sixb] Could not end every run beyond recovery.")
  }

  return { republished: jobs.length, settled: beyondRecovery.length - failures.length }
}

async function settleRun<TRun extends LostRunCandidate>(
  input: RepublishLostRunsInput,
  lane: RunLane<TRun>,
  run: TRun
): Promise<void> {
  const failure = lostWorkerFailure(input, run)

  await lane.cancelChildren?.(run, failure)
  const finished = await lane.cancel(run, failure)

  await input.events.emit(
    { events: [finished], correlationId: await readCorrelationId(input, run) },
    { source: SOURCE }
  )
}

async function recoverProjections(input: RepublishLostRunsInput): Promise<RepublishLostRunsResult> {
  const { projectId, storage, queues, projections } = input
  const { projectionRuns } = storage
  if (!projectionRuns) return { republished: 0, settled: 0 }

  const jobOnItsWay = new Date(input.now.getTime() - JOB_ON_ITS_WAY_MS)

  const lapsed = await projectionRuns.listLapsed({
    projectId,
    lapsedBy: jobOnItsWay,
    limit: input.limit ?? DEFAULT_LIMIT,
  })

  const jobs = lapsed.map(recoveryJob)

  if (jobs.length > 0) {
    await queues.projections.enqueue({
      projectId,
      jobs: queueJobs("projection.run.requested", jobs),
    })
  }

  const queued = projections
    ? await republishQueuedProjectionRuns({
        projectId,
        projectionRuns,
        queuedBefore: jobOnItsWay,
        recovery: projections,
        signal: input.signal,
      })
    : 0

  return { republished: jobs.length + queued, settled: 0 }
}

/**
 * A queued run's id is stable, so a job still waiting in the queue absorbs this one. A running run's
 * own job may be settled, so it gets one of its own.
 */
function recoveryJob(run: LostRunCandidate): RecoveryJob {
  const id = run.status === "queued" ? run.id : recoverJobId(run.id, run.attempt)

  return { id, runId: run.id }
}

function queueJobs<TType extends string>(type: TType, jobs: readonly RecoveryJob[]) {
  return jobs.map(({ id, runId }) => ({ id, type, payload: { runId } }))
}

type LaneInput = Pick<RepublishLostRunsInput, "projectId" | "storage" | "queues" | "now">

function syncLane({ projectId, storage, queues }: LaneInput) {
  const runs = storage.syncRuns
  if (!runs) return undefined

  return {
    primitive: "sync",
    listLost: (filter) => runs.listLost({ ...filter, projectId }),

    enqueue: (jobs) =>
      queues.syncRuns.enqueue({ projectId, jobs: queueJobs("sync.run.requested", jobs) }),

    async cancel(run, failure) {
      await runs.finish({ projectId, id: run.id, status: "cancelled", error: failure })

      return {
        type: "sync.run.finished",
        payload: {
          syncId: run.syncId,
          runId: run.id,
          status: "cancelled",
          datasetId: run.datasetId,
          error: failure,
        },
      }
    },
  } satisfies RunLane<NonNullable<Awaited<ReturnType<typeof runs.getById>>>>
}

function pipelineLane({ projectId, storage, queues }: LaneInput) {
  const runs = storage.pipelineRuns
  if (!runs) return undefined

  return {
    primitive: "pipeline",
    listLost: (filter) => runs.listLost({ ...filter, projectId }),

    enqueue: (jobs) =>
      queues.pipelines.enqueue({ projectId, jobs: queueJobs("pipeline.run.requested", jobs) }),

    async cancelChildren(run, failure) {
      const { steps } = await runs.listSteps({
        projectId,
        pipelineRunId: run.id,
        statuses: ["running"],
      })

      for (const step of steps) {
        await runs.finishStep({ projectId, id: step.id, status: "cancelled", error: failure })
      }
    },

    async cancel(run, failure) {
      await runs.finish({ projectId, id: run.id, status: "cancelled", error: failure })

      return {
        type: "pipeline.run.finished",
        payload: {
          pipelineId: run.pipelineId,
          runId: run.id,
          status: "cancelled",
          error: failure,
        },
      }
    },
  } satisfies RunLane<NonNullable<Awaited<ReturnType<typeof runs.getById>>>>
}

function workflowLane({ projectId, storage, queues, now }: LaneInput) {
  const runs = storage.workflowRuns
  if (!runs) return undefined

  return {
    primitive: "workflow",
    listLost: (filter) => runs.listLost({ ...filter, projectId }),

    enqueue: (jobs) =>
      queues.workflows.enqueue({ projectId, jobs: queueJobs("workflow.run.requested", jobs) }),

    async cancelChildren(run, failure) {
      const { nodes } = await runs.nodes.list({
        projectId,
        workflowRunId: run.id,
        statuses: ["running"],
      })

      for (const node of nodes) {
        await runs.nodes.finish({ projectId, id: node.id, status: "cancelled", error: failure })
      }
    },

    async cancel(run, failure) {
      const finished = await runs.finish({
        projectId,
        id: run.id,
        status: "cancelled",
        error: failure,
      })

      return {
        type: "workflow.run.finished",
        payload: {
          workflowId: run.workflowId,
          runId: run.id,
          status: "cancelled",
          finishedAt: (finished.finishedAt ?? now).toISOString(),
          error: failure,
        },
      }
    },
  } satisfies RunLane<NonNullable<Awaited<ReturnType<typeof runs.getById>>>>
}

function lostWorkerFailure(input: RepublishLostRunsInput, run: LostRunCandidate): LostRunFailure {
  const lost = withFailureMessage(new Error(`[Sixb] Run '${run.id}' lost its worker.`), LOST_WORKER)

  return captureSixbFailure(lost, {
    allowedCodes: ["runtime.cancelled"],
    defaultCode: "runtime.cancelled",
    details: { runId: run.id },
    at: input.now,
  })
}

/** Its execution ties its events together. A run may have lost even that: its id then does. */
async function readCorrelationId(
  input: RepublishLostRunsInput,
  run: LostRunCandidate
): Promise<string> {
  const execution = await input.storage.executions
    .getById({ projectId: input.projectId, id: run.executionId })
    .catch(() => null)

  return execution?.correlationId ?? run.id
}
