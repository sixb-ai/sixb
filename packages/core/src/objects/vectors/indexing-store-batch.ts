import type { ExecutionScope } from "../../execution/types"
import { MaterializationConflictError } from "../../materialization/errors"
import type { ObjectVectorWrite } from "../../materialization/vectors"
import type { OntologyMaterializerContract } from "../../materializer/materializer"
import type { SixbHostContext } from "../../runtime/types"
import {
  commitPreparedVectors,
  prepare,
  storeVector,
  VectorIndexingDeferred,
} from "./indexing-shared"

/** Publish a current subset atomically; reprepare conflicts without repeating inference. */
export async function storeVectorBatch(
  runtime: SixbHostContext,
  materializer: OntologyMaterializerContract,
  batchId: string,
  scope: ExecutionScope,
  signal: AbortSignal
): Promise<void> {
  const indexing = runtime.storage.ontology.vectorIndexing!
  const identity = { projectId: runtime.projectId, batchId }

  for (let attempt = 0; attempt < 3; attempt++) {
    const ready = (await indexing.getBatch(identity)).filter((work) => work.status === "ready")
    const writes: ObjectVectorWrite[] = []

    for (const work of ready) {
      signal.throwIfAborted()
      const input = await prepare(runtime, work)
      if (input) {
        writes.push({ input, values: work.values! })
      } else {
        await indexing.remove({ projectId: runtime.projectId, id: work.id })
      }
    }

    if (!writes.length) return

    try {
      signal.throwIfAborted()
      await commitPreparedVectors(materializer, scope, writes)
      return
    } catch (error) {
      if (!(error instanceof MaterializationConflictError)) throw error
    }
  }

  // A continuously changing object must not keep stable peers from becoming searchable.
  let deferred = false
  for (const work of await indexing.getBatch(identity)) {
    if (work.status !== "ready") continue
    try {
      await storeVector(runtime, materializer, work, scope, signal)
    } catch (error) {
      if (!(error instanceof VectorIndexingDeferred)) throw error
      deferred = true
    }
  }

  if (deferred) throw new VectorIndexingDeferred(new Date(Date.now() + 1000).toISOString())
}
