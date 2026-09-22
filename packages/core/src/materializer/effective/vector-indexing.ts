import { randomUUID } from "node:crypto"
import type { OntologyObjectRef } from "../../materialization/model"
import { vectorConfiguration, vectorSources } from "../../objects/vectors/profile"
import type { Storage } from "../../storage"
import { objectBatchKey } from "../../storage/objects/keys"
import type { MaterializationSession } from "../../storage/ontology"
import type { VectorIndexingRequest } from "../../storage/ontology/vector-indexing"
import type { MaterializerContext } from "../context"
import type { MaterializationPlanItem } from "../execution/plan-stream"

/** Source assertions are not effective values: schedule only after conflict resolution. */
export async function scheduleVectorChanges(
  context: Pick<MaterializerContext, "projectId" | "ontology" | "clock">,
  storage: Storage,
  items: readonly MaterializationPlanItem[],
  session: MaterializationSession,
  projection = false
): Promise<void> {
  const indexing = storage.ontology.vectorIndexing
  if (!indexing) return
  const upserts = items
    .filter((item) => item.kind === "object-upsert")
    .filter(
      (item) =>
        Object.keys(
          context.ontology.resolveObjectType(item.value.row.ref.objectTypeId).search?.vectors ?? {}
        ).length > 0
    )
  const previous = await storage.objects.getByPrimaryIdBatch({
    projectId: context.projectId,
    items: upserts.map((item) => item.value.row.ref),
  })
  const requests: VectorIndexingRequest[] = []
  const deleted: OntologyObjectRef[] = []
  // Groups exist only for this materialization page and are persisted in its transaction.
  const groups = new Map<string, { id: string; count: number; bytes: number }>()
  for (const item of items) {
    if (item.kind === "object-delete") {
      deleted.push(item.value.ref)
      continue
    }
    if (item.kind !== "object-upsert") continue
    const row = item.value.row
    const profiles = context.ontology.resolveObjectType(row.ref.objectTypeId).search?.vectors ?? {}
    const before = previous.get(objectBatchKey(row.ref.objectTypeId, row.ref.primaryId))
    for (const [profile, definition] of Object.entries(profiles)) {
      const { sourceFingerprint, text } = vectorSources(definition.source, row.properties)
      if (
        before &&
        vectorSources(definition.source, before.properties).sourceFingerprint === sourceFingerprint
      )
        continue
      const configuration = vectorConfiguration(definition)
      const bytes = Buffer.byteLength(text)
      const key = JSON.stringify([row.ref.objectTypeId, profile, configuration, row.lastCommitId])
      let group = projection ? groups.get(key) : undefined
      if (projection && (!group || group.count === 32 || group.bytes + bytes > 32_768)) {
        group = { id: randomUUID(), count: 0, bytes: 0 }
        groups.set(key, group)
      }
      if (group) {
        group.count++
        group.bytes += bytes
      }
      requests.push({
        ...(group ? { batchId: group.id } : {}),
        id: randomUUID(),
        ref: row.ref,
        profile,
        sourceFingerprint,
        configuration,
        sourceCommitId: row.lastCommitId,
      })
    }
  }
  if (requests.length || deleted.length)
    await indexing.schedule({
      projectId: context.projectId,
      session,
      requests,
      deleted,
      availableAt: context.clock().toISOString(),
    })
}
