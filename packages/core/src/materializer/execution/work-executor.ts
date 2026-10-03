import { utf8JsonByteLength } from "../../materialization/refs"
import type { Storage } from "../../storage"
import type {
  MaterializationSession,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { scheduleVectorChanges } from "../effective/vector-indexing"
import { invalidateVectorChanges } from "../effective/vectors"
import { throwIfAborted } from "../shared/abort"
import { chunkBySize } from "../shared/chunking"

type BatchingContext = Pick<MaterializerContext, "batching">

export async function stageWorkBounded(
  context: BatchingContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  records: readonly MaterializationWorkRecord[]
): Promise<void> {
  for await (const chunk of chunkBySize(records, {
    maxRows: context.batching.planChunkRows,
    maxBytes: context.batching.planChunkBytes,
    byteLength: utf8JsonByteLength,
  })) {
    await storage.stageWork({ session, records: chunk })
  }
}

/**
 * Hands the staged plan to storage, which applies it and writes its events. Vector profiles see
 * the object changes first, while the objects still hold their previous values.
 */
export async function applyStagedWork(
  context: Pick<MaterializerContext, "batching" | "projectId" | "ontology" | "clock">,
  transactionStorage: Storage,
  session: MaterializationSession,
  signal?: AbortSignal,
  projection = false
): Promise<number> {
  const ontologyStorage = transactionStorage.ontology
  const storage = ontologyStorage.materializations
  if (ontologyStorage.vectorIndexing || ontologyStorage.vectors) {
    for await (const page of storage.streamVectorChanges({
      session,
      objectTypeIds: context.ontology
        .listObjectTypes()
        .filter((type) => Object.keys(type.search?.vectors ?? {}).length > 0)
        .map((type) => type.id),
      pageRows: context.batching.planChunkRows,
    })) {
      throwIfAborted(signal)
      await scheduleVectorChanges(context, transactionStorage, page.items, session, projection)
      await invalidateVectorChanges(context.projectId, ontologyStorage.vectors, page.items, session)
    }
  }
  throwIfAborted(signal)
  const { eventCount } = await storage.apply({ session })
  return eventCount
}
