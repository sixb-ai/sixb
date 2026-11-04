import { COMMITTING_PROVIDER, sameLineage, versionLineage } from "./lineage"
import type { DatasetVersion } from "./types"

/** What a commit would store: `lineage` is the one `lineageAtCommit` returned for it. */
export type DatasetCommitProvenance = Pick<
  DatasetVersion,
  "datasetId" | "schema" | "producer" | "inputs" | "lineage"
>

/**
 * Provenance participates in write identity: identical rows computed from other input versions,
 * or with a lineage that classifies them otherwise, still create a version. Reusing the latest
 * version would keep provenance that no longer describes the newest calculation.
 *
 * `next` holds what the commit would store, after `lineageAtCommit` merged in the parent's
 * lineage. Lineages compare as `hasDatasetLineageChanges` compares them. Inputs count only when
 * the writer passed them.
 */
export function hasDatasetProvenanceChanges(
  latest: DatasetCommitProvenance & Pick<DatasetVersion, "versionId">,
  next: DatasetCommitProvenance
): boolean {
  return (
    hasDatasetInputChanges(latest.inputs, next.inputs) || hasDatasetLineageChanges(latest, next)
  )
}

/**
 * Whether a version's lineage classifies its rows otherwise than its parent's, which a provider
 * stores as `DatasetVersion.lineageChanged`. `next` holds the lineage `lineageAtCommit` returned
 * for it, and a version without a parent changes lineage.
 *
 * Lineages compare whatever their order and repetition; an unknown lineage, or a pipeline version
 * that records none, differs from any known one.
 */
export function hasDatasetLineageChanges(
  parent: DatasetCommitProvenance | null | undefined,
  next: DatasetCommitProvenance
): boolean {
  return (
    !parent ||
    !sameLineage(
      versionLineage(parent, COMMITTING_PROVIDER),
      versionLineage(next, COMMITTING_PROVIDER)
    )
  )
}

function hasDatasetInputChanges(
  previous: DatasetVersion["inputs"],
  next: DatasetVersion["inputs"]
): boolean {
  if (next === undefined) return false
  const keys = (refs: NonNullable<DatasetVersion["inputs"]>) =>
    new Set(refs.map((ref) => JSON.stringify([ref.datasetId, ref.versionId])))
  const before = keys(previous ?? [])
  const after = keys(next)
  return before.size !== after.size || [...after].some((key) => !before.has(key))
}
