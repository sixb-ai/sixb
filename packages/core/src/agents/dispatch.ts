import type { AgentQueueJob, Queue } from "../queues"
import type { AgentStorage } from "../storage/agents"

export interface DispatchQueuedAgentRunsInput {
  readonly projectId: string
  readonly storage: AgentStorage
  readonly queue: Queue<AgentQueueJob>
  /** Dispatch only these runs. Omitted scans the oldest queued runs. */
  readonly runIds?: readonly string[]
  readonly limit?: number
}

export interface DispatchedAgentRun {
  readonly runId: string
  readonly jobId: string
}

export interface AgentRunDispatchFailure {
  readonly runId: string
  readonly error: unknown
}

export interface DispatchQueuedAgentRunsResult {
  readonly scanned: number
  readonly dispatched: readonly DispatchedAgentRun[]
  readonly failures: readonly AgentRunDispatchFailure[]
}

/** Stable queue identity: repeated publication of one durable run is idempotent. */
export function agentRunQueueJobId(runId: string): string {
  return `agt_job_${runId}`
}

/** Stable queue identity shared by workflow dispatch and agent reconciliation. */
export function workflowAgentNodeQueueJobId(nodeRunId: string): string {
  return `wfa_job_${nodeRunId}`
}

/**
 * Publish durable queued runs to the agent queue.
 *
 * The queued run is the dispatch intent, so no parallel outbox record is needed. Callers may run
 * this concurrently: the deterministic queue job id collapses repeated publication to one active
 * job, while the worker's queued→running transition remains the execution authority.
 */
export async function dispatchQueuedAgentRuns(
  input: DispatchQueuedAgentRunsInput
): Promise<DispatchQueuedAgentRunsResult> {
  const limit = normalizeLimit(input.limit)
  const runs = input.runIds
    ? await input.storage.runs.getByIds({
        projectId: input.projectId,
        ids: [...new Set(input.runIds)].slice(0, limit),
      })
    : (
        await input.storage.runs.list({
          projectId: input.projectId,
          statuses: ["queued"],
          order: "asc",
          limit,
        })
      ).runs

  const queued = runs.filter((run) => run.status === "queued")
  if (queued.length === 0) {
    return { scanned: 0, dispatched: [], failures: [] }
  }

  try {
    const jobs = await input.queue.enqueue({
      projectId: input.projectId,
      jobs: queued.map((run) => ({
        id: agentRunQueueJobId(run.id),
        type: "agent.run.requested" as const,
        payload: {
          agentId: run.agentId,
          threadId: run.threadId,
          runId: run.id,
          triggerMessageId: run.triggerMessageId,
        },
      })),
    })
    const jobsById = new Map(jobs.map((job) => [job.id, job]))
    const dispatched = queued.map((run) => {
      const jobId = agentRunQueueJobId(run.id)
      if (!jobsById.has(jobId)) {
        throw new Error(`[Sixb] Agent queue did not return job '${jobId}'.`)
      }
      return { runId: run.id, jobId }
    })
    return { scanned: queued.length, dispatched, failures: [] }
  } catch (error) {
    return {
      scanned: queued.length,
      dispatched: [],
      failures: queued.map((run) => ({ runId: run.id, error })),
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("[Sixb] Agent dispatch limit must be at least 1.")
  }
  return Math.floor(value)
}
