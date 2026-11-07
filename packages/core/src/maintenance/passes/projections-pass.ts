import { createSixbError } from "../../errors/internal"
import type { DatasetLatestVersionSummary, DatasetVersion, LakeStorage } from "../../lake-storage"
import type { ProjectionRunDispatchPort } from "../../projections/run-dispatch"
import type { ProjectionDispatchDescriptor } from "../../projections/types"
import type { MaintenancePass } from "../loop"
import type { LakeChangeFeed, LakeChangeReader } from "./lake-change-feed"
import { recoveryPass } from "./recovery-pass"

export interface ProjectionsPassInput {
  readonly projectId: string
  readonly dispatcher: ProjectionRunDispatchPort
  readonly descriptors: readonly ProjectionDispatchDescriptor[]
  readonly feed: LakeChangeFeed
  readonly lakeStorage: Pick<LakeStorage, "getLatestVersion" | "getVersion" | "listVersions">
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
 * Runs that lost their publication are the `runs` pass's (see `republishQueuedProjectionRuns`).
 */
export function projectionsPass(input: ProjectionsPassInput): MaintenancePass {
  const recovery = new ProjectionRecovery(input)

  return recoveryPass("projections", (signal) => recovery.run(signal))
}

class ProjectionRecovery {
  private readonly descriptorsByDatasetId: ReadonlyMap<string, ProjectionDispatchDescriptor[]>
  /** Projections whose latest data version must be looked up rather than taken from the feed. */
  private readonly unverified: Set<string>
  private readonly changes: LakeChangeReader

  constructor(private readonly input: ProjectionsPassInput) {
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
  async run(signal: AbortSignal): Promise<void> {
    const failures = await this.dispatchMissedVersions(signal)

    if (failures.length > 0) {
      throw new AggregateError(failures, "[Sixb] The projections pass failed.")
    }
  }

  private async dispatchMissedVersions(signal: AbortSignal): Promise<readonly Error[]> {
    let versions: readonly DatasetLatestVersionSummary[]

    try {
      versions = await this.changes.read()
    } catch (error) {
      const unread = new Error(
        `[Sixb] The projections pass could not read the lake change feed (projectId=${this.input.projectId}).`,
        { cause: error }
      )

      // Look everything up instead. Nothing counts as verified: a lookup only covers the feed's
      // gap when it follows a successful read.
      const { failures } = await this.dispatchLatest(this.input.descriptors, signal)

      return [unread, ...failures]
    }

    const failures = await this.dispatchChanged(versions, signal)

    // Lookups follow the feed read, so a commit racing them is in the next read.
    const unverified = this.input.descriptors.filter(({ projectionId }) =>
      this.unverified.has(projectionId)
    )
    const looked = await this.dispatchLatest(unverified, signal)

    for (const projectionId of looked.verified) this.unverified.delete(projectionId)

    return [...failures, ...looked.failures]
  }

  /** A projection that could not be dispatched goes back to being looked up. */
  private async dispatchChanged(
    versions: readonly DatasetLatestVersionSummary[],
    signal: AbortSignal
  ): Promise<readonly Error[]> {
    const failures: Error[] = []

    for (const version of versions) {
      for (const descriptor of this.descriptorsByDatasetId.get(version.datasetId) ?? []) {
        if (this.unverified.has(descriptor.projectionId)) continue

        try {
          await this.dispatch(descriptor, version, signal)
        } catch (error) {
          failures.push(dispatchFailure(descriptor, error))
          this.unverified.add(descriptor.projectionId)
        }
      }
    }

    return failures
  }

  /** Dispatches each projection's latest data version. Projections of one dataset share its lookup. */
  private async dispatchLatest(
    descriptors: readonly ProjectionDispatchDescriptor[],
    signal: AbortSignal
  ): Promise<{ readonly verified: readonly string[]; readonly failures: readonly Error[] }> {
    const verified: string[] = []
    const failures: Error[] = []

    for (const [datasetId, siblings] of groupByDataset(descriptors)) {
      let version: DatasetVersion | null

      try {
        version = await findLatestDataVersion({
          lakeStorage: this.input.lakeStorage,
          projectId: this.input.projectId,
          datasetId,
        })
      } catch (error) {
        failures.push(...siblings.map((descriptor) => dispatchFailure(descriptor, error)))
        continue
      }

      for (const descriptor of siblings) {
        try {
          if (version) await this.dispatch(descriptor, version, signal)
          verified.push(descriptor.projectionId)
        } catch (error) {
          failures.push(dispatchFailure(descriptor, error))
        }
      }
    }

    return { verified, failures }
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
}

function dispatchFailure(descriptor: ProjectionDispatchDescriptor, error: unknown): Error {
  return new Error(
    `[Sixb] The projections pass could not dispatch (projectionId=${descriptor.projectionId}, datasetId=${descriptor.datasetId}).`,
    { cause: error }
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
  readonly lakeStorage: ProjectionsPassInput["lakeStorage"]
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
        `[Sixb] Dataset '${input.datasetId}' version ancestry contains a cycle at '${version.versionId}'.`,
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
        `[Sixb] Dataset '${input.datasetId}' schema version references missing parent '${parentVersionId}'.`,
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
