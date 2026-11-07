import { createSixbError } from "@sixb/core/internal/errors"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import type { DatasetLatestVersionSummary, DatasetVersion } from "@sixb/core/lake-storage"
import type { ListProjectionRunsInput, ProjectionRunRecord } from "@sixb/core/storage"
import type { LakeChangeFeed, LakeChangeReader } from "./lake-change-feed"
import type { ProjectionDispatcherPort, ProjectionReconciliationPorts } from "./types"

const STUCK_RUN_PAGE_SIZE = 100

interface ProjectionDispatchReconcilerInput extends ProjectionReconciliationPorts {
  readonly projectId: string
  readonly dispatcher: ProjectionDispatcherPort
  readonly descriptors: readonly ProjectionDispatchDescriptor[]
  readonly feed: LakeChangeFeed
  /** Pause between passes, which also counts a run as stuck once it stayed `queued` for longer. */
  readonly intervalMs: number
}

/**
 * Recovers what the live `dataset.version.committed` path can lose, at a cost that follows what
 * changed rather than the lake's history.
 *
 * Missed triggers: each pass reads the lake's change feed, whose cursor is memory, and dispatches
 * the newest data version of each changed dataset. A projection the feed cannot vouch for is
 * looked up directly instead: every projection on the first pass (the cursor starts at the lake's
 * current position, and routes may have changed since the last process), and any projection
 * whose dispatch failed. A restart repeats that first pass, so the cursor needs no storage.
 *
 * Lost publications: runs `queued` for longer than one interval, or failed with a retryable
 * enqueue error, are dispatched again, and the dispatcher republishes the same run and job.
 */
export class ProjectionDispatchReconciler {
  private readonly descriptorsByDatasetId: ReadonlyMap<string, ProjectionDispatchDescriptor[]>
  /** Projections whose latest data version must be looked up rather than taken from the feed. */
  private readonly unverified: Set<string>
  private readonly changes: LakeChangeReader

  constructor(private readonly input: ProjectionDispatchReconcilerInput) {
    this.descriptorsByDatasetId = groupByDataset(input.descriptors)
    this.unverified = new Set(input.descriptors.map((descriptor) => descriptor.projectionId))
    this.changes = input.feed.subscribe({
      datasetIds: this.descriptorsByDatasetId.keys(),
      // The cursor is no longer a position in this lake: verify everything against current state.
      onCursorLost: () => {
        for (const descriptor of input.descriptors) this.unverified.add(descriptor.projectionId)
      },
    })
  }

  /**
   * One pass does all it can, then throws what failed, so that the loop counts it. A projection
   * that could not be dispatched stays unverified, and the next pass looks it up.
   */
  async pass(signal: AbortSignal, now = Date.now()): Promise<void> {
    const failures: Error[] = []

    await this.reconcileTriggers(signal, failures)
    await this.republishStuckRuns(signal, now, failures)

    if (failures.length > 0) {
      throw new AggregateError(failures, "[SixbOrchestrator] Projection reconciliation failed.")
    }
  }

  private async reconcileTriggers(signal: AbortSignal, failures: Error[]): Promise<void> {
    let versions: readonly DatasetLatestVersionSummary[]
    try {
      versions = await this.changes.read()
    } catch (error) {
      failures.push(
        new Error(
          `[SixbOrchestrator] Projection dispatch reconciliation could not read the lake change feed (projectId=${this.input.projectId}).`,
          { cause: error }
        )
      )
      // Look everything up instead. Nothing counts as verified: a lookup only covers the feed's
      // gap when it follows a successful read.
      await this.reconcileLatest(this.input.descriptors, signal, failures)
      return
    }

    for (const version of versions) {
      for (const descriptor of this.descriptorsByDatasetId.get(version.datasetId) ?? []) {
        if (this.unverified.has(descriptor.projectionId)) continue
        try {
          await this.dispatch(descriptor, version, signal)
        } catch (error) {
          failures.push(reconciliationFailure(descriptor, error))
          this.unverified.add(descriptor.projectionId)
        }
      }
    }
    // Lookups follow the feed read, so a commit racing them is in the next read.
    const verified = await this.reconcileLatest(
      this.input.descriptors.filter((descriptor) => this.unverified.has(descriptor.projectionId)),
      signal,
      failures
    )
    for (const projectionId of verified) this.unverified.delete(projectionId)
  }

  /**
   * Dispatches each projection's latest data version; returns the projections that succeeded.
   * Projections of one dataset share its lookup.
   */
  private async reconcileLatest(
    descriptors: readonly ProjectionDispatchDescriptor[],
    signal: AbortSignal,
    failures: Error[]
  ): Promise<readonly string[]> {
    const reconciled: string[] = []
    for (const [datasetId, siblings] of groupByDataset(descriptors)) {
      let version: DatasetVersion | null
      try {
        version = await findLatestDataVersion({
          lakeStorage: this.input.lakeStorage,
          projectId: this.input.projectId,
          datasetId,
        })
      } catch (error) {
        failures.push(...siblings.map((descriptor) => reconciliationFailure(descriptor, error)))
        continue
      }
      for (const descriptor of siblings) {
        try {
          if (version) await this.dispatch(descriptor, version, signal)
          reconciled.push(descriptor.projectionId)
        } catch (error) {
          failures.push(reconciliationFailure(descriptor, error))
        }
      }
    }
    return reconciled
  }

  private async dispatch(
    descriptor: ProjectionDispatchDescriptor,
    version: Pick<DatasetVersion | DatasetLatestVersionSummary, "versionId" | "createdAt">,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
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

  private async republishStuckRuns(
    signal: AbortSignal,
    now: number,
    failures: Error[]
  ): Promise<void> {
    let runs: ProjectionRunRecord[]
    try {
      const [queued, enqueueFailed] = await Promise.all([
        this.listRuns({
          statuses: ["queued"],
          // Younger runs may still be in their first publication.
          startedBefore: new Date(now - this.input.intervalMs),
        }),
        this.listRuns({ statuses: ["failed"], errorCodes: ["queue.enqueue_failed"] }),
      ])
      runs = [...queued, ...enqueueFailed.filter((run) => run.error?.retryable)]
    } catch (error) {
      failures.push(
        new Error(
          `[SixbOrchestrator] Projection run recovery could not list stuck runs (projectId=${this.input.projectId}).`,
          { cause: error }
        )
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
        signal.throwIfAborted()
        await this.input.dispatcher.dispatch({
          projectionId: descriptor.projectionId,
          datasetVersion: structuredClone(run.identity.datasetVersion),
          metadata: { dispatchSource: "run-recovery" },
        })
      } catch (error) {
        failures.push(
          new Error(
            `[SixbOrchestrator] Projection run recovery failed (projectionId=${descriptor.projectionId}, runId=${run.id}).`,
            { cause: error }
          )
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

function reconciliationFailure(descriptor: ProjectionDispatchDescriptor, error: unknown): Error {
  return new Error(
    `[SixbOrchestrator] Projection dispatch reconciliation failed (projectionId=${descriptor.projectionId}, datasetId=${descriptor.datasetId}).`,
    { cause: error }
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

function groupByDataset(
  descriptors: readonly ProjectionDispatchDescriptor[]
): Map<string, ProjectionDispatchDescriptor[]> {
  const byDatasetId = new Map<string, ProjectionDispatchDescriptor[]>()
  for (const descriptor of descriptors) {
    const siblings = byDatasetId.get(descriptor.datasetId) ?? []
    siblings.push(descriptor)
    byDatasetId.set(descriptor.datasetId, siblings)
  }
  return byDatasetId
}

async function findLatestDataVersion(input: {
  readonly lakeStorage: ProjectionReconciliationPorts["lakeStorage"]
  readonly projectId: string
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
