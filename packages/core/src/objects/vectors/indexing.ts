import type { OntologyMaterializerContract } from "../../materializer/materializer"
import type { SixbHostContext } from "../../runtime/types"
import { processVectorBatch } from "./indexing-batch"
import type { VectorIndexingRuntime } from "./indexing-runtime"
import { processVector } from "./indexing-single"

export { VectorIndexingDeferred } from "./indexing-shared"

/** Internal processing port; durable projection groups and individual requests share delivery. */
export function createVectorIndexingRuntime(
  runtime: SixbHostContext,
  materializer: OntologyMaterializerContract
): VectorIndexingRuntime {
  return {
    async process(id, attempt, signal) {
      const indexing = runtime.storage.ontology.vectorIndexing
      if (!indexing) throw new Error("[Sixb] Storage does not support automatic vector indexing.")
      const batch = await indexing.getBatch({ projectId: runtime.projectId, batchId: id })
      if (batch.length) await processVectorBatch(runtime, materializer, id, batch, attempt, signal)
      else await processVector(runtime, materializer, id, attempt, signal)
    },
  }
}
