import type { OntologyMaterializerContract } from "../../materializer/materializer"
import type { EmbeddingBatchLimits } from "../../models/embedding-model"
import type { SixbHostContext } from "../../runtime/types"
import type { VectorIndexingWork } from "../../storage/ontology/vector-indexing"
import { generateVectors, type PreparedIndexingWork } from "./indexing-generate"
import { indexingScope, prepare, VectorIndexingDeferred } from "./indexing-shared"
import { processVector } from "./indexing-single"
import { storeVectorBatch } from "./indexing-store-batch"

/** Membership was persisted by one projection commit; there is no fill timer or memory queue. */
export async function processVectorBatch(
  runtime: SixbHostContext,
  materializer: OntologyMaterializerContract,
  batchId: string,
  batch: readonly VectorIndexingWork[],
  attempt: number,
  signal: AbortSignal
): Promise<void> {
  if (batch.some((work) => work.status !== "pending")) {
    await resumeBatch(runtime, materializer, batchId, batch, attempt, signal)
    return
  }

  const entries = await prepareBatch(runtime, batch, signal)
  const first = entries[0]
  if (!first) return

  const limits = getBatchLimits(runtime, first.work)
  if (!limits) {
    // Unknown provider batch limits: embed each object/profile individually.
    for (const { work } of entries) {
      await processVector(runtime, materializer, work.id, attempt, signal)
    }
    return
  }

  assertCompatibleEntries(entries, first.work)
  const scope = await indexingScope(runtime, first.work, batchId)

  for (const group of partition(entries, limits)) {
    if (group.length === 1) {
      await processVector(runtime, materializer, group[0]!.work.id, attempt, signal)
    } else {
      await generateVectors(runtime, group, scope, attempt, signal)
    }
  }

  await storeVectorBatch(runtime, materializer, batchId, scope, signal)
}

/** Resume storage or terminalize interrupted calls; never repeat paid inference. */
async function resumeBatch(
  runtime: SixbHostContext,
  materializer: OntologyMaterializerContract,
  batchId: string,
  batch: readonly VectorIndexingWork[],
  attempt: number,
  signal: AbortSignal
): Promise<void> {
  const ready = batch.find((work) => work.status === "ready")
  if (ready) {
    const scope = await indexingScope(runtime, ready, batchId)
    await storeVectorBatch(runtime, materializer, batchId, scope, signal)
  }

  for (const work of batch) {
    if (work.status !== "ready") {
      await processVector(runtime, materializer, work.id, attempt, signal)
    }
  }
}

async function prepareBatch(
  runtime: SixbHostContext,
  batch: readonly VectorIndexingWork[],
  signal: AbortSignal
): Promise<PreparedIndexingWork[]> {
  const availableAt = batch.reduce(
    (latest, work) => (work.availableAt > latest ? work.availableAt : latest),
    ""
  )
  if (Date.parse(availableAt) > Date.now()) {
    throw new VectorIndexingDeferred(availableAt)
  }

  const entries: PreparedIndexingWork[] = []
  const indexing = runtime.storage.ontology.vectorIndexing!

  for (const work of batch) {
    signal.throwIfAborted()
    const input = await prepare(runtime, work)

    if (input) {
      entries.push({ work, input })
    } else {
      await indexing.remove({ projectId: runtime.projectId, id: work.id })
    }
  }

  return entries
}

function getBatchLimits(
  runtime: SixbHostContext,
  work: VectorIndexingWork
): EmbeddingBatchLimits | undefined {
  const profile = runtime.ontology.resolveObjectType(work.ref.objectTypeId).search!.vectors![
    work.profile
  ]!

  return runtime.embeddingModels?.getByRef({
    provider: profile.model.providerId,
    modelId: profile.model.modelId,
  })?.model.batching
}

/** Do not mix commits or configurations, even with malformed storage membership. */
function assertCompatibleEntries(
  entries: readonly PreparedIndexingWork[],
  reference: VectorIndexingWork
): void {
  const incompatible = entries.some(
    ({ work }) =>
      work.sourceCommitId !== reference.sourceCommitId ||
      work.ref.objectTypeId !== reference.ref.objectTypeId ||
      work.profile !== reference.profile ||
      work.configuration !== reference.configuration
  )

  if (incompatible) {
    throw new Error("[Sixb] Incompatible vector batch membership.")
  }
}

/** Split an already durable, bounded page; never wait for more work or truncate input. */
function* partition(entries: readonly PreparedIndexingWork[], limits: EmbeddingBatchLimits) {
  let group: PreparedIndexingWork[] = []
  let bytes = 0

  for (const entry of entries) {
    const size = Buffer.byteLength(entry.input.text)
    const exceedsGroupLimit =
      group.length >= limits.maxInputs ||
      bytes + size > limits.maxTotalInputBytes ||
      size > limits.maxInputBytes

    if (group.length > 0 && exceedsGroupLimit) {
      yield group
      group = []
      bytes = 0
    }

    if (size > limits.maxInputBytes || size > limits.maxTotalInputBytes) {
      yield [entry]
      continue
    }

    group.push(entry)
    bytes += size
  }

  if (group.length > 0) yield group
}
