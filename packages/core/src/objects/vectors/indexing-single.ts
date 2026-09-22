import { createSixbError } from "../../errors/internal"
import type { OntologyMaterializerContract } from "../../materializer/materializer"
import type { SixbHostContext } from "../../runtime/types"
import { generateVectors } from "./indexing-generate"
import {
  fail,
  indexingScope,
  prepare,
  storeVector,
  VectorIndexingDeferred,
} from "./indexing-shared"

export async function processVector(
  runtime: SixbHostContext,
  materializer: OntologyMaterializerContract,
  id: string,
  attempt: number,
  signal: AbortSignal
): Promise<void> {
  const indexing = runtime.storage.ontology.vectorIndexing
  if (!indexing) throw new Error("[Sixb] Storage does not support automatic vector indexing.")
  const projectId = runtime.projectId
  const work = await indexing.get({ projectId, id })
  if (!work || work.status === "failed") return
  if (work.status === "running") {
    await fail(
      runtime,
      indexing,
      work,
      createSixbError(
        "vector.outcome_unknown",
        "[Sixb] Interrupted embedding call has an unknown outcome; inference was not repeated."
      )
    )
    return
  }
  if (Date.parse(work.availableAt) > Date.now()) throw new VectorIndexingDeferred(work.availableAt)
  const prepared = await prepare(runtime, work)
  if (!prepared) {
    await indexing.remove({ projectId, id })
    return
  }
  const scope = await indexingScope(runtime, work, work.batchId ?? work.id)
  if (work.status === "ready") {
    await storeVector(runtime, materializer, work, scope, signal)
    return
  }
  await generateVectors(runtime, [{ work, input: prepared }], scope, attempt, signal)
  const ready = await indexing.get({ projectId, id })
  if (ready?.status === "ready") await storeVector(runtime, materializer, ready, scope, signal)
}
