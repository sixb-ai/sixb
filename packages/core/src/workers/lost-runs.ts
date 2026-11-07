import { captureSixbFailure, withFailureMessage } from "../errors/internal"
import type { SixbFailure } from "../errors/types"
import type { DomainEventLog, EventsAppendInput } from "../events/service"
import type { Queues } from "../queues"
import type { Storage } from "../storage"
import { type ClaimableRun, hasLapsedLease, isOrphanedRun } from "../storage/run-claim"

/** A run younger than this may still be in its first publication. */
const QUEUED_GRACE_MS = 30_000
const DEFAULT_LIMIT = 100

const SOURCE = "SixbRunRecovery"
const LOST_WORKER = "The worker running it was lost, and nothing can resume it."

export interface RepublishLostRunsInput {
  readonly projectId: string
  readonly storage: Pick<Storage, "executions" | "syncRuns" | "pipelineRuns" | "workflowRuns">
  readonly queues: Pick<Queues, "syncRuns" | "pipelines" | "workflows">
  readonly events: Pick<DomainEventLog, "emit">
  readonly now: Date
  /** Most runs of each primitive and status one call looks at, oldest first. */
  readonly limit?: number
}

export interface RepublishLostRunsResult {
  /** Jobs published for runs that had none. */
  readonly republished: number
  /** Runs of an older version given up on, which end `cancelled`. */
  readonly settled: number
}

interface LostRunCandidate extends ClaimableRun {
  readonly executionId: string
}

type LostRunFailure = SixbFailure<"runtime.cancelled">

/** What differs between the primitives this pass looks after. */
interface RunLane<TRun extends LostRunCandidate> {
  list(input: {
    readonly statuses: ["queued"] | ["running"]
    readonly startedBefore?: Date
    readonly limit: number
  }): Promise<readonly TRun[]>
  enqueue(job: readonly { readonly id: string; readonly runId: string }[]): Promise<void>
  /** End what the run left running, its steps or its nodes. */
  cancelChildren(run: TRun, failure: LostRunFailure): Promise<void>
  cancel(run: TRun, failure: LostRunFailure): Promise<EventsAppendInput["events"][number]>
}

/**
 * What keeps a run from staying unfinished for good, for syncs, pipelines and workflows:
 *
 * - A queued run whose job never made it, or was lost with the queue, gets a job.
 * - A running run whose lease lapsed, which covers one handed back, gets a job.
 * - A running run with no lease, from a version that held none, is given time to end on its old
 *   worker, then ends `cancelled`. A cancelled run does not count as having read its inputs, so
 *   the triggers that were waiting on it fire again.
 *
 * A delivery that finds the run held or finished does nothing, so this can be wrong about a job
 * being lost without doing harm.
 */
export async function republishLostRuns(
  input: RepublishLostRunsInput
): Promise<RepublishLostRunsResult> {
  const lanes = [
    recoverLane(input, syncLane(input)),
    recoverLane(input, pipelineLane(input)),
    recoverLane(input, workflowLane(input)),
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

async function recoverLane<TRun extends LostRunCandidate>(
  input: RepublishLostRunsInput,
  lane: RunLane<TRun> | undefined
): Promise<RepublishLostRunsResult> {
  if (!lane) return { republished: 0, settled: 0 }

  const { now } = input
  const limit = input.limit ?? DEFAULT_LIMIT

  const [queued, running] = await Promise.all([
    lane.list({
      statuses: ["queued"],
      startedBefore: new Date(now.getTime() - QUEUED_GRACE_MS),
      limit,
    }),
    lane.list({ statuses: ["running"], limit }),
  ])

  const orphans = running.filter((run) => isOrphanedRun(run, now))
  for (const run of orphans) {
    const failure = lostWorkerFailure(input, run)

    await lane.cancelChildren(run, failure)
    const finished = await lane.cancel(run, failure)

    await input.events.emit(
      { events: [finished], correlationId: await readCorrelationId(input, run) },
      { source: SOURCE }
    )
  }

  const jobs = [
    // Stable, so a job still waiting in the queue absorbs this one.
    ...queued.map((run) => ({ id: run.id, runId: run.id })),
    ...running.filter((run) => hasLapsedLease(run, now)).map(recoveryJob),
  ]

  if (jobs.length > 0) await lane.enqueue(jobs)
  return { republished: jobs.length, settled: orphans.length }
}

/**
 * The job that brings a running run back. The run's own job id may be settled, and a provider
 * ignores a new job under a settled id. Stable per attempt, so whoever publishes it, once is enough.
 */
export function recoveryJob(run: Pick<ClaimableRun, "id" | "attempt">): {
  readonly id: string
  readonly runId: string
} {
  return { id: `${run.id}:recover:${run.attempt}`, runId: run.id }
}

function syncLane({ projectId, storage, queues }: RepublishLostRunsInput) {
  const runs = storage.syncRuns
  if (!runs) return undefined

  return {
    list: async (filter) => (await runs.list({ ...filter, projectId, order: "asc" })).runs,

    async enqueue(jobs) {
      await queues.syncRuns.enqueue({
        projectId,
        jobs: jobs.map(({ id, runId }) => ({
          id,
          type: "sync.run.requested",
          payload: { runId },
        })),
      })
    },

    async cancelChildren() {},

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

function pipelineLane({ projectId, storage, queues }: RepublishLostRunsInput) {
  const runs = storage.pipelineRuns
  if (!runs) return undefined

  return {
    list: async (filter) => (await runs.list({ ...filter, projectId, order: "asc" })).runs,

    async enqueue(jobs) {
      await queues.pipelines.enqueue({
        projectId,
        jobs: jobs.map(({ id, runId }) => ({
          id,
          type: "pipeline.run.requested",
          payload: { runId },
        })),
      })
    },

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

function workflowLane({ projectId, storage, queues, now }: RepublishLostRunsInput) {
  const runs = storage.workflowRuns
  if (!runs) return undefined

  return {
    list: async (filter) => (await runs.list({ ...filter, projectId, order: "asc" })).runs,

    async enqueue(jobs) {
      await queues.workflows.enqueue({
        projectId,
        jobs: jobs.map(({ id, runId }) => ({
          id,
          type: "workflow.run.requested",
          payload: { runId },
        })),
      })
    },

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
