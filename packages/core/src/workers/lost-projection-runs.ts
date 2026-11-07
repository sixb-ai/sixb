import type { ProjectionRunDispatchPort } from "../projections/run-dispatch"
import type { ProjectionDispatchDescriptor } from "../projections/types"
import type { ListProjectionRunsInput, ProjectionRunRecord, Storage } from "../storage"

const PAGE_SIZE = 100

/** What decides whether a projection's queued run still applies, and republishes it if so. */
export interface ProjectionRunRecovery {
  readonly descriptors: readonly ProjectionDispatchDescriptor[]
  readonly dispatcher: ProjectionRunDispatchPort
}

interface LostProjectionRunsInput {
  readonly projectId: string
  readonly projectionRuns: NonNullable<Storage["projectionRuns"]>
  /** Younger runs may still be in their first publication. */
  readonly queuedBefore: Date
  readonly recovery: ProjectionRunRecovery
}

/**
 * Dispatches again the runs `queued` past their first publication, and those that failed with a
 * retryable enqueue error: the dispatcher republishes the same run and job, so whoever asks, it
 * is one. A run admitted under another definition revision belongs to an earlier deployment, and
 * the current revision is admitted from the lake instead. So a projection, unlike the other
 * primitives, needs the revision check its dispatcher carries to bring a queued run back.
 */
export async function republishQueuedProjectionRuns(
  input: LostProjectionRunsInput
): Promise<number> {
  const { dispatcher, descriptors } = input.recovery
  const runs = await listQueuedRuns(input)
  const failures: Error[] = []
  let republished = 0

  for (const run of runs) {
    const descriptor = descriptors.find(
      (candidate) => candidate.projectionId === run.identity.projectionId
    )
    if (!descriptor || !admittedUnder(run, descriptor)) continue

    try {
      await dispatcher.dispatch({
        projectionId: descriptor.projectionId,
        datasetVersion: structuredClone(run.identity.datasetVersion),
        metadata: { dispatchSource: "run-recovery" },
      })
      republished += 1
    } catch (error) {
      failures.push(
        new Error(
          `[Sixb] Could not republish a projection run (projectionId=${descriptor.projectionId}, runId=${run.id}).`,
          { cause: error }
        )
      )
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "[Sixb] Could not republish every projection run.")
  }

  return republished
}

async function listQueuedRuns(
  input: LostProjectionRunsInput
): Promise<readonly ProjectionRunRecord[]> {
  const [queued, enqueueFailed] = await Promise.all([
    listRuns(input, { statuses: ["queued"], startedBefore: input.queuedBefore }),
    listRuns(input, { statuses: ["failed"], errorCodes: ["queue.enqueue_failed"] }),
  ])

  return [...queued, ...enqueueFailed.filter((run) => run.error?.retryable)]
}

async function listRuns(
  { projectId, projectionRuns }: LostProjectionRunsInput,
  filter: Omit<ListProjectionRunsInput, "projectId" | "limit" | "offset" | "order">
): Promise<readonly ProjectionRunRecord[]> {
  const runs: ProjectionRunRecord[] = []

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await projectionRuns.list({
      ...filter,
      projectId,
      order: "asc",
      limit: PAGE_SIZE,
      offset,
    })

    runs.push(...page.runs)
    if (!page.hasMore) return runs
  }
}

function admittedUnder(
  run: ProjectionRunRecord,
  descriptor: ProjectionDispatchDescriptor
): boolean {
  const { identity } = run

  return (
    identity.datasetVersion.datasetId === descriptor.datasetId &&
    identity.projectionKind === descriptor.projectionKind &&
    identity.protocol === descriptor.protocol &&
    identity.ontologyRevision === descriptor.ontologyRevision &&
    identity.projectionRevision === descriptor.projectionRevision &&
    identity.ownershipHash === descriptor.ownershipHash
  )
}
