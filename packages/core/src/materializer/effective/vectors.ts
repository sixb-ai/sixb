import { vectorSources } from "../../objects/vectors/profile"
import type { MaterializationSession } from "../../storage/ontology"
import type { OntologyVectorStorage } from "../../storage/ontology/vectors"
import type { MaterializationPlanItem } from "../execution/plan-stream"

/** Invalidate only affected representations, inside the same transaction as effective writes. */
export async function invalidateVectorChanges(
  projectId: string,
  vectors: OntologyVectorStorage | undefined,
  items: readonly MaterializationPlanItem[],
  session: MaterializationSession
): Promise<void> {
  if (!vectors) return
  for (const item of items) {
    if (item.kind !== "object-upsert" && item.kind !== "object-delete") continue
    const ref = item.kind === "object-upsert" ? item.value.row.ref : item.value.ref
    for (const entry of await vectors.list({ projectId, ref })) {
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
      await vectors.remove({
        session,
        projectId,
        ref,
        profile: entry.profile,
        expectedCommitId: entry.lastCommitId,
      })
    }
  }
}
