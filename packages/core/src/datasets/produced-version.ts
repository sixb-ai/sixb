import type { DatasetVersion, LakeStorage } from "../lake-storage/types"

/** The newest versions a lookup reads first, then four times as many. */
const LOOKUP_VERSIONS = 200
/** How far writers' clocks may disagree on when a version committed. */
const LOOKUP_CLOCK_SKEW_MS = 60_000

export interface FindProducedVersionInput {
  readonly lakeStorage: Pick<LakeStorage, "listVersions">
  readonly datasetId: string
  /** The producer that may have committed, and what any commit of its says about itself. */
  readonly producer: {
    readonly kind: "sync" | "pipeline" | "ingest"
    readonly runId: string
    readonly stepId?: string
  }
  /** Started no later than the commit could have landed. */
  readonly since: Date
}

/**
 * Whether a producer's commit landed, for one that cannot remember: a lake commit and the record
 * of it are not one transaction, so whoever takes over after a crash asks the lake. Reads the
 * dataset's newest versions back to `since`, widening the window until it gets there: an answer
 * of "no" that hadn't read that far could write the same data twice.
 */
export async function findProducedVersion(
  input: FindProducedVersionInput
): Promise<DatasetVersion | null> {
  const { datasetId, producer } = input
  const oldestPossible = input.since.getTime() - LOOKUP_CLOCK_SKEW_MS

  for (let limit = LOOKUP_VERSIONS; ; limit *= 4) {
    const versions = await input.lakeStorage.listVersions(datasetId, limit)

    for (const version of versions) {
      if (isProducedBy(version, producer)) return version

      if (version.createdAt.getTime() < oldestPossible) return null
    }

    if (versions.length < limit) return null
  }
}

function isProducedBy(
  version: DatasetVersion,
  producer: FindProducedVersionInput["producer"]
): boolean {
  return (
    version.producer?.kind === producer.kind &&
    version.producer.runId === producer.runId &&
    version.producer.stepId === producer.stepId
  )
}
