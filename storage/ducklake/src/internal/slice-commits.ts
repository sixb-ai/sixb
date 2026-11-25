import type { DatasetColumnRef, DatasetProducer } from "@sixb/core/lake-storage"
import { decodeLineage, encodeLineage } from "./lineage-encoding"
import { parseCommitMetadata, type SixbCommitMetadata } from "./versions"

/**
 * The Sixb commit metadata of a version, as a slice keeps it: what its reader sees in production
 * and what the branch needs, nothing more.
 *
 * - The producer is the one given, as the reader sees it (`visibleProducer`): no run, step or
 *   execution id they could not see.
 * - Inputs and lineage name only the slice's datasets. The branch reads no other dataset, and a
 *   lineage ref to one would only name it. A version's columns keep the markings their own
 *   definition and the slice's datasets declare; its reader reads all of them in full anyway.
 * - An unknown lineage stays unknown, without the reason, which may name an upstream version.
 * - Everything else is kept as written: modes, row counts and the facts writes on the branch rely
 *   on, such as validated keys.
 */
export function sliceCommitInfo(
  stored: string | undefined,
  input: {
    readonly datasetIds: ReadonlySet<string>
    readonly producer: DatasetProducer | undefined
  }
): string | undefined {
  const metadata = parseCommitMetadata(stored)
  if (metadata === undefined) return undefined

  const { producer: _producer, inputs, lineage, ...kept }: SixbCommitMetadata = metadata

  const sixb = {
    ...kept,
    ...(input.producer === undefined ? {} : { producer: input.producer }),
    ...(inputs === undefined
      ? {}
      : { inputs: inputs.filter((ref) => input.datasetIds.has(ref.datasetId)) }),
    ...(lineage === undefined
      ? {}
      : { lineage: lineageWithin(metadata.datasetId, lineage, input.datasetIds) }),
  }
  return JSON.stringify({ sixb })
}

function lineageWithin(
  datasetId: string,
  stored: unknown,
  datasetIds: ReadonlySet<string>
): string {
  const lineage = decodeLineage(datasetId, stored)
  if ("unknown" in lineage) {
    return encodeLineage({ unknown: `the lineage of a version of '${datasetId}' is unknown` })
  }

  const within = (refs: readonly DatasetColumnRef[]) =>
    refs.filter((ref) => datasetIds.has(ref.datasetId))
  return encodeLineage({
    rows: within(lineage.rows),
    columns: Object.fromEntries(
      Object.entries(lineage.columns).map(([column, refs]) => [column, within(refs)])
    ),
  })
}
