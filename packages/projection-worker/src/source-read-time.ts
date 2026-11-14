import type { DatasetVersion, DatasetVersionRef, LakeStorage } from "@sixb/core/lake-storage"
import type { SyncRunStorage } from "@sixb/core/storage"

/** Most versions one walk reads. A lineage wider than this has an unknown read time. */
const MAX_LINEAGE_VERSIONS = 100

/**
 * When the source data of `version` started being read: the earliest start of the sync runs that
 * wrote it or the versions it is computed from, through every pipeline in between. The earliest,
 * because the version is only as recent as the oldest data it holds.
 *
 * A sync run starts before it reads anything, and a retried run keeps its first start, so the time
 * never comes after the read it stands for. It is unknown as soon as one branch cannot tell: an
 * ingested version, a pipeline version without inputs, a version the lake no longer holds, a run
 * storage no longer keeps, or a lineage wider than {@link MAX_LINEAGE_VERSIONS}.
 */
export async function resolveSourceReadAt(input: {
  readonly projectId: string
  readonly version: DatasetVersion
  readonly lakeStorage: Pick<LakeStorage, "getVersion">
  readonly syncRuns: Pick<SyncRunStorage, "getById">
}): Promise<string | undefined> {
  const seen = new Set([versionKey(input.version)])
  const syncRunIds = new Set<string>()
  let frontier: readonly DatasetVersion[] = [input.version]

  while (frontier.length > 0) {
    const inputs: DatasetVersionRef[] = []

    for (const version of frontier) {
      const { producer } = version

      if (producer?.kind === "sync" && producer.runId) {
        syncRunIds.add(producer.runId)
        continue
      }

      if (producer?.kind !== "pipeline" || !version.inputs?.length) return undefined

      for (const ref of version.inputs) {
        const key = versionKey(ref)
        if (seen.has(key)) continue

        seen.add(key)
        inputs.push(ref)
      }
    }

    if (seen.size > MAX_LINEAGE_VERSIONS) return undefined

    const versions = await Promise.all(
      inputs.map((ref) => input.lakeStorage.getVersion(ref.datasetId, ref.versionId))
    )
    if (versions.some((version) => version === null)) return undefined

    frontier = versions.filter((version) => version !== null)
  }

  const runs = await Promise.all(
    [...syncRunIds].map((id) => input.syncRuns.getById({ projectId: input.projectId, id }))
  )

  let earliest: Date | undefined
  for (const run of runs) {
    if (!run?.startedAt) return undefined
    if (!earliest || run.startedAt < earliest) earliest = run.startedAt
  }

  return earliest?.toISOString()
}

function versionKey(ref: DatasetVersionRef): string {
  return JSON.stringify([ref.datasetId, ref.versionId])
}
