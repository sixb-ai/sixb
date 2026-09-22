import { createSixbError, isSixbError } from "../../errors/internal"
import type { ExecutionScope } from "../../execution/types"
import type { PreparedObjectVector } from "../../materialization/vectors"
import {
  EmbeddingModelResponseError,
  type EmbeddingModelResult,
  sameEmbeddingModel,
} from "../../models/embedding-model"
import { bindEmbeddingModels } from "../../models/execution/embedding"
import { ModelExecutionSession } from "../../models/execution/session"
import type { SixbHostContext } from "../../runtime/types"
import type { VectorIndexingWork } from "../../storage/ontology/vector-indexing"
import { fail, retryAt, VectorIndexingDeferred } from "./indexing-shared"
import { normalizeVector } from "./profile"

export interface PreparedIndexingWork {
  readonly work: VectorIndexingWork
  readonly input: PreparedObjectVector
}

interface GenerationAttempt {
  readonly runtime: SixbHostContext
  readonly entries: readonly PreparedIndexingWork[]
  readonly signal: AbortSignal
  /** Running means the durable claim succeeded; budget admission may still be pending. */
  phase: "pending" | "claiming" | "running"
}

/** One accounted provider call, with durable admission and atomic result persistence. */
export async function generateVectors(
  runtime: SixbHostContext,
  entries: readonly PreparedIndexingWork[],
  scope: ExecutionScope,
  attempt: number,
  signal: AbortSignal
): Promise<void> {
  const first = entries[0]!
  const profile = runtime.ontology.resolveObjectType(first.work.ref.objectTypeId).search!.vectors![
    first.work.profile
  ]!
  const generation: GenerationAttempt = { runtime, entries, signal, phase: "pending" }

  const session = new ModelExecutionSession(
    { ...runtime, runtimeAuthorization: scope.authorization },
    scope.execution
  )
  session.bind({
    attempt,
    signal,
    embeddingAdmission: (admit) => admitGeneration(generation, admit),
  })

  try {
    const model = bindEmbeddingModels(runtime.embeddingModels, session)?.getByRef({
      provider: profile.model.providerId,
      modelId: profile.model.modelId,
    })?.model

    if (!model || !sameEmbeddingModel(model, profile.model)) {
      throw createSixbError(
        "vector.model_unavailable",
        "[Sixb] Vector indexing requires the profile's configured embedding model."
      )
    }

    const result = await model.embed({ texts: entries.map((entry) => entry.input.text), signal })
    const values = normalizeEmbeddingResult(
      result,
      entries.length,
      profile.model.definition.dimensions
    )

    // Persist every surviving result atomically before any vector is published.
    await runtime.storage.ontology.vectorIndexing!.updateBatch({
      projectId: runtime.projectId,
      updates: entries.map(({ work }, index) => ({
        id: work.id,
        expectedStatus: "running",
        status: "ready",
        values: values[index]!,
        availableAt: new Date().toISOString(),
      })),
    })
  } catch (error) {
    await handleGenerationFailure(generation, error)
  }
}

async function admitGeneration(
  generation: GenerationAttempt,
  admit: () => Promise<void>
): Promise<void> {
  generation.signal.throwIfAborted()
  generation.phase = "claiming"

  const claimed = await transitionWork(generation, "pending", "running", { requireAll: true })
  generation.phase = claimed ? "running" : "pending"

  if (!claimed) {
    if (generation.entries.length === 1) {
      throw new Error("[Sixb] Vector indexing request was superseded.")
    }
    throw new VectorIndexingDeferred(new Date().toISOString())
  }

  try {
    await admit()
  } catch (error) {
    await transitionWork(generation, "running", "pending")
    generation.phase = "pending"
    throw error
  }
}

function normalizeEmbeddingResult(
  result: EmbeddingModelResult,
  count: number,
  dimensions: number
): readonly (readonly number[])[] {
  try {
    if (!Array.isArray(result?.vectors) || result.vectors.length !== count) {
      throw new Error("Unexpected vector count")
    }

    return result.vectors.map((vector) => normalizeVector(vector, dimensions))
  } catch (cause) {
    throw createSixbError("vector.response_invalid", "[Sixb] Invalid embedding batch response.", {
      cause,
    })
  }
}

async function handleGenerationFailure(
  generation: GenerationAttempt,
  error: unknown
): Promise<void> {
  // No provider call can start while the storage claim is unresolved. Retry delivery,
  // not inference; an ambiguously committed claim will be fenced as running on redelivery.
  if (generation.phase === "claiming" || error instanceof VectorIndexingDeferred) {
    throw error
  }

  if (generation.phase === "pending") {
    if (
      isSixbError(error) &&
      (error.code === "ai.usage_limit_exceeded" || error.code === "ai.usage_limit_unavailable")
    ) {
      const availableAt = retryAt(error.details)
      await transitionWork(generation, "pending", "pending", { availableAt })
      throw new VectorIndexingDeferred(availableAt)
    }

    if (generation.signal.aborted) throw error
  }

  const failure =
    error instanceof EmbeddingModelResponseError
      ? createSixbError("vector.response_invalid", "[Sixb] Invalid embedding batch response.", {
          cause: error,
        })
      : error
  const { runtime, entries } = generation
  const indexing = runtime.storage.ontology.vectorIndexing!

  for (const { work } of entries) {
    await fail(runtime, indexing, { ...work, status: generation.phase }, failure)
  }
}

function transitionWork(
  generation: GenerationAttempt,
  expectedStatus: VectorIndexingWork["status"],
  status: VectorIndexingWork["status"],
  options: { availableAt?: string; requireAll?: boolean } = {}
): Promise<boolean> {
  const { runtime, entries } = generation
  const availableAt = options.availableAt ?? new Date().toISOString()

  return runtime.storage.ontology.vectorIndexing!.updateBatch({
    projectId: runtime.projectId,
    requireAll: options.requireAll ?? false,
    updates: entries.map(({ work }) => ({ id: work.id, expectedStatus, status, availableAt })),
  })
}
