import { MaterializationConflictError } from "./errors"
import type { PinnedDatasetVersion } from "./model"

export type PinnedDatasetWatermarkConflict =
  | "version-metadata-mismatch"
  | "older-version"
  | "ambiguous-version"

/**
 * Orders versions of one dataset. A projection rebound to a different dataset starts a new
 * watermark: versions of two datasets have no order, and whether a run may read that dataset is
 * decided by the registered definition, which rejects runs pinned to any other dataset.
 */
export function comparePinnedDatasetWatermarks(
  active: PinnedDatasetVersion,
  next: PinnedDatasetVersion
): PinnedDatasetWatermarkConflict | null {
  if (active.datasetId !== next.datasetId) return null
  if (active.versionId === next.versionId && active.createdAt !== next.createdAt) {
    return "version-metadata-mismatch"
  }

  const activeAt = Date.parse(active.createdAt)
  const nextAt = Date.parse(next.createdAt)
  if (nextAt < activeAt) return "older-version"
  if (nextAt === activeAt && next.versionId !== active.versionId) return "ambiguous-version"
  return null
}

export function assertPinnedDatasetWatermark(
  active: PinnedDatasetVersion,
  next: PinnedDatasetVersion,
  subject: string
): void {
  const conflict = comparePinnedDatasetWatermarks(active, next)
  if (!conflict) return

  const message = pinnedDatasetWatermarkConflictMessage(conflict, subject)
  throw new MaterializationConflictError("projection-fence", message)
}

function pinnedDatasetWatermarkConflictMessage(
  conflict: PinnedDatasetWatermarkConflict,
  subject: string
): string {
  switch (conflict) {
    case "version-metadata-mismatch":
      return `${subject} reused an immutable dataset version id with different metadata.`
    case "older-version":
      return `${subject} dataset version is older than the active watermark.`
    case "ambiguous-version":
      return `${subject} dataset watermark is ambiguous.`
  }
}
