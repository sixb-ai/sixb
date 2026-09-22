import { objectRefKey } from "../../materialization/refs"
import { vectorSources } from "../../objects/vectors/profile"
import type { MaterializationSession } from "../../storage/ontology"
import type { OntologyVectorStorage } from "../../storage/ontology/vectors"
import type { MaterializationPlanItem } from "../execution/plan-stream"

/** Invalidate a bounded materialization page, including stored profiles no longer declared. */
export async function invalidateVectorChanges(
  projectId: string,
  vectors: OntologyVectorStorage | undefined,
  items: readonly MaterializationPlanItem[],
  session: MaterializationSession
): Promise<void> {
  if (!vectors) return
  const changes = new Map(
    items.flatMap((item) => {
      if (item.kind !== "object-upsert" && item.kind !== "object-delete") return []
      const ref = item.kind === "object-upsert" ? item.value.row.ref : item.value.ref
      return [[objectRefKey(ref), { ref, item }] as const]
    })
  )
  if (!changes.size) return

  const stored = await vectors.listBatch({
    projectId,
    refs: [...changes.values()].map(({ ref }) => ref),
  })
  const removals: Parameters<OntologyVectorStorage["removeBatch"]>[0]["entries"][number][] = []
  for (const entry of stored) {
    const change = changes.get(objectRefKey(entry.ref))
    if (!change) continue
    const { item } = change
    if (
      item.kind === "object-upsert" &&
      entry.source.every((id) => {
        const value = item.value.row.properties[id]
        return value === undefined || value === null || typeof value === "string"
      }) &&
      vectorSources(entry.source, item.value.row.properties).sourceFingerprint ===
        entry.sourceFingerprint
    )
      continue

    removals.push({ ref: entry.ref, profile: entry.profile, expectedCommitId: entry.lastCommitId })
  }
  if (removals.length) await vectors.removeBatch({ session, projectId, entries: removals })
}
