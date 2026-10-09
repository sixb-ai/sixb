import { createSixbError } from "@sixb/core/internal/errors"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import type {
  DatasetLatestVersionSummary,
  DatasetVersion,
  LatestVersionsSince,
} from "@sixb/core/lake-storage"
import type { ListProjectionRunsInput, ProjectionRunRecord } from "@sixb/core/storage"
import type { ProjectionDispatcherPort, ProjectionReconciliationPorts } from "./types"

const INTERVAL_MS = 30_000
const STUCK_RUN_PAGE_SIZE = 100

interface ProjectionDispatchReconcilerInput extends ProjectionReconciliationPorts {
  readonly projectId: string
  readonly dispatcher: ProjectionDispatcherPort
  readonly descriptors: readonly ProjectionDispatchDescriptor[]
}

export async function runProjectionDispatchReconciler(
  input: ProjectionDispatchReconcilerInput,
  signal: AbortSignal
): Promise<void> {
  const reconciler = new ProjectionDispatchReconciler(input)
  while (!signal.aborted) {
    await reconciler.pass()
    await waitForNextPass(reconciler.intervalMs, signal)
  }
}

/**
 * Recovers what the live `dataset.version.committed` path can lose, at a cost that follows what
 * changed rather than the lake's history.
 *
 * Missed triggers: each pass reads the lake's change feed from an in-memory cursor and dispatches
 * the newest data version of each changed dataset. A projection the feed cannot vouch for is
 * looked up directly instead: every projection on the first pass (the cursor starts at the lake's
 * current position, and routes may have changed since the last process), and any projection
 * whose dispatch failed. A restart repeats that first pass, so the cursor needs no storage.
 *
 * Lost publications: runs `queued` for longer than one interval, or failed with a retryable
 * enqueue error, are dispatched again, and the dispatcher republishes the same run and job.
 */
export class ProjectionDispatchReconciler {
  readonly intervalMs: number
  private readonly descriptorsByDatasetId = new Map<string, ProjectionDispatchDescriptor[]>()
  /** Projections whose latest data version must be looked up rather than taken from the feed. */
  private readonly unverified = new Set<string>()
  private cursor: string | null = null

  constructor(private readonly input: ProjectionDispatchReconcilerInput) {
    this.intervalMs = input.intervalMs ?? INTERVAL_MS
    for (const descriptor of input.descriptors) {
      const siblings = this.descriptorsByDatasetId.get(descriptor.datasetId) ?? []
      siblings.push(descriptor)
      this.descriptorsByDatasetId.set(descriptor.datasetId, siblings)
      this.unverified.add(descriptor.projectionId)
    }
  }

  async pass(now = Date.now()): Promise<void> {
    await this.reconcileTriggers()
    await this.republishStuckRuns(now)
  }

  private async reconcileTriggers(): Promise<void> {
    let changes: LatestVersionsSince
    try {
      changes = await this.readChangeFeed()
    } catch (error) {
      console.error(
        `[SixbOrchestrator] Projection dispatch reconciliation could not read the lake change feed (projectId=${this.input.projectId}):`,
        error
      )
      // Look everything up instead. Nothing counts as verified: a lookup only covers the feed's
      // gap when it follows a successful read.
      await this.reconcileLatest(this.input.descriptors)
      return
    }

    for (const version of changes.versions) {
      for (const descriptor of this.descriptorsByDatasetId.get(version.datasetId) ?? []) {
        if (this.unverified.has(descriptor.projectionId)) continue
        try {
          await this.dispatch(descriptor, version)
        } catch (error) {
          reportReconciliationFailure(descriptor, error)
          this.unverified.add(descriptor.projectionId)
        }
      }
    }
    // Lookups follow the feed read, so a commit racing them is in the next read.
    const verified = await this.reconcileLatest(
      this.input.descriptors.filter((descriptor) => this.unverified.has(descriptor.projectionId))
    )
    for (const projectionId of verified) this.unverified.delete(projectionId)
    this.cursor = changes.cursor
  }

  private async readChangeFeed(): Promise<LatestVersionsSince> {
    const lake = this.input.lakeStorage
    const read = (cursor: string | null) =>
      lake.listLatestVersionsSince({
        cursor,
        datasetIds: [...this.descriptorsByDatasetId.keys()],
      })
    const changes = await read(this.cursor)
    if (changes) return changes

    // The cursor is no longer a position in this lake: verify everything against current state.
    for (const descriptor of this.input.descriptors) this.unverified.add(descriptor.projectionId)
    const restarted = await read(null)
    if (restarted) return restarted
    throw createSixbError(
      "internal.unexpected",
      "[SixbOrchestrator] Lake change feed rejected a null cursor.",
      { details: { projectId: this.input.projectId } }
    )
  }

  /** Dispatches each projection's latest data version; returns the projections that succeeded. */
  private async reconcileLatest(
    descriptors: readonly ProjectionDispatchDescriptor[]
  ): Promise<readonly string[]> {
    const reconciled: string[] = []
    for (const descriptor of descriptors) {
      try {
        const version = await findLatestDataVersion({
          lakeStorage: this.input.lakeStorage,
          projectId: this.input.projectId,
          projectionId: descriptor.projectionId,
          datasetId: descriptor.datasetId,
        })
        if (version) await this.dispatch(descriptor, version)
        reconciled.push(descriptor.projectionId)
      } catch (error) {
        reportReconciliationFailure(descriptor, error)
      }
    }
    return reconciled
  }

  private async dispatch(
    descriptor: ProjectionDispatchDescriptor,
    version: Pick<DatasetVersion | DatasetLatestVersionSummary, "versionId" | "createdAt">
  ): Promise<void> {
    await this.input.dispatcher.dispatch({
      projectionId: descriptor.projectionId,
      datasetVersion: {
        datasetId: descriptor.datasetId,
        versionId: version.versionId,
        createdAt: version.createdAt.toISOString(),
      },
      metadata: { dispatchSource: "lake-reconciliation" },
    })
  }

  private async republishStuckRuns(now: number): Promise<void> {
    let runs: ProjectionRunRecord[]
    try {
      const [queued, enqueueFailed] = await Promise.all([
        this.listRuns({
          statuses: ["queued"],
          // Younger runs may still be in their first publication.
          startedBefore: new Date(now - this.intervalMs),
        }),
        this.listRuns({ statuses: ["failed"], errorCodes: ["queue.enqueue_failed"] }),
      ])
      runs = [...queued, ...enqueueFailed.filter((run) => run.error?.retryable)]
    } catch (error) {
      console.error(
        `[SixbOrchestrator] Projection run recovery could not list stuck runs (projectId=${this.input.projectId}):`,
        error
      )
      return
    }

    for (const run of runs) {
      const descriptor = this.input.descriptors.find(
        (candidate) => candidate.projectionId === run.identity.projectionId
      )
      // A run admitted under another definition revision belongs to an earlier deployment; the
      // current revision is reconciled from the lake instead.
      if (!descriptor || !admittedUnder(run, descriptor)) continue
      try {
        await this.input.dispatcher.dispatch({
          projectionId: descriptor.projectionId,
          datasetVersion: structuredClone(run.identity.datasetVersion),
          metadata: { dispatchSource: "run-recovery" },
        })
      } catch (error) {
        console.error(
          `[SixbOrchestrator] Projection run recovery failed (projectionId=${descriptor.projectionId}, runId=${run.id}):`,
          error
        )
      }
    }
  }

  private async listRuns(
    filter: Omit<ListProjectionRunsInput, "projectId" | "limit" | "offset" | "order">
  ): Promise<ProjectionRunRecord[]> {
    const runs: ProjectionRunRecord[] = []
    for (let offset = 0; ; offset += STUCK_RUN_PAGE_SIZE) {
      const page = await this.input.projectionRuns.list({
        ...filter,
        projectId: this.input.projectId,
        order: "asc",
        limit: STUCK_RUN_PAGE_SIZE,
        offset,
      })
      runs.push(...page.runs)
      if (!page.hasMore) return runs
    }
  }
}

function reportReconciliationFailure(
  descriptor: ProjectionDispatchDescriptor,
  error: unknown
): void {
  console.error(
    `[SixbOrchestrator] Projection dispatch reconciliation failed (projectionId=${descriptor.projectionId}, datasetId=${descriptor.datasetId}):`,
    error
  )
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

async function findLatestDataVersion(input: {
  readonly lakeStorage: ProjectionReconciliationPorts["lakeStorage"]
  readonly projectId: string
  readonly projectionId: string
  readonly datasetId: string
}): Promise<DatasetVersion | null> {
  let version = await input.lakeStorage.getLatestVersion(input.datasetId)
  const visited = new Set<string>()

  while (version?.mode === "schema") {
    if (!version.parentVersionId) {
      const versions = await input.lakeStorage.listVersions(input.datasetId)
      return versions.find((candidate) => candidate.mode !== "schema") ?? null
    }
    if (visited.has(version.versionId)) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbOrchestrator] Dataset '${input.datasetId}' version ancestry contains a cycle at '${version.versionId}'.`,
        {
          details: {
            projectId: input.projectId,
            projectionId: input.projectionId,
            datasetId: input.datasetId,
            versionId: version.versionId,
          },
        }
      )
    }
    visited.add(version.versionId)
    const schemaVersionId = version.versionId
    const parentVersionId = version.parentVersionId
    version = await input.lakeStorage.getVersion(input.datasetId, parentVersionId)
    if (!version) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbOrchestrator] Dataset '${input.datasetId}' schema version references missing parent '${parentVersionId}'.`,
        {
          details: {
            projectId: input.projectId,
            projectionId: input.projectionId,
            datasetId: input.datasetId,
            versionId: schemaVersionId,
            parentVersionId,
          },
        }
      )
    }
  }

  return version
}

async function waitForNextPass(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, intervalMs)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}
