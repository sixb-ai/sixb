import { randomUUID } from "node:crypto"
import { reportVectorIndexingFailure } from "../../error-reporting/capability"
import { captureSixbFailure, createSixbError, isSixbError } from "../../errors/internal"
import { createKernelRuntimeAuthorization } from "../../execution/authorization"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../../execution/durable"
import type { ExecutionContext, ExecutionScope } from "../../execution/types"
import { MaterializationConflictError } from "../../materialization/errors"
import type { PreparedObjectVector } from "../../materialization/vectors"
import type { OntologyMaterializerContract } from "../../materializer/materializer"
import {
  EmbeddingModelResponseError,
  type EmbeddingModelResult,
} from "../../models/embedding-model"
import { bindEmbeddingModels } from "../../models/execution/embedding"
import { ModelExecutionSession } from "../../models/execution/session"
import type { SixbHostContext } from "../../runtime/types"
import {
  type OntologyVectorIndexingStorage,
  VECTOR_INDEXING_FAILURE_CODES,
  type VectorIndexingWork,
} from "../../storage/ontology/vector-indexing"
import type { VectorIndexingRuntime } from "./indexing-runtime"
import { normalizeVector, vectorConfiguration, vectorSources } from "./profile"

/** Internal port: it never binds kernel authority to the domain SDK. */
export function createVectorIndexingRuntime(
  runtime: SixbHostContext,
  materializer: OntologyMaterializerContract
): VectorIndexingRuntime {
  return {
    process: (id, attempt, signal) => processVector(runtime, materializer, id, attempt, signal),
  }
}

async function processVector(
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
  const scope = await indexingScope(runtime, work)
  if (work.status === "ready") {
    await storeVector(runtime, materializer, work, scope, signal)
    return
  }
  await generateVector(runtime, indexing, work, prepared, scope, attempt, signal)
  const ready = await indexing.get({ projectId, id })
  if (ready?.status === "ready") await storeVector(runtime, materializer, ready, scope, signal)
}

async function generateVector(
  runtime: SixbHostContext,
  indexing: OntologyVectorIndexingStorage,
  work: VectorIndexingWork,
  prepared: PreparedObjectVector,
  scope: ExecutionScope,
  attempt: number,
  signal: AbortSignal
): Promise<void> {
  const projectId = runtime.projectId
  const id = work.id
  const session = new ModelExecutionSession(
    { ...runtime, runtimeAuthorization: scope.authorization },
    scope.execution
  )
  let started = false
  session.bind({
    attempt,
    signal,
    embeddingAdmission: async (admit) => {
      signal.throwIfAborted()
      started = await indexing.update({
        projectId,
        id,
        expectedStatus: "pending",
        status: "running",
        availableAt: new Date().toISOString(),
      })
      if (!started) throw new Error("[Sixb] Vector indexing request was superseded.")
      try {
        await admit()
      } catch (error) {
        // Admission failed before any provider call, so redelivery is safe.
        started = false
        await indexing.update({
          projectId,
          id,
          expectedStatus: "running",
          status: "pending",
          availableAt: new Date().toISOString(),
        })
        throw error
      }
    },
  })
  const definition = runtime.ontology.resolveObjectType(work.ref.objectTypeId).search!.vectors![
    work.profile
  ]!
  const model = bindEmbeddingModels(runtime.embeddingModels, session)?.getByRef({
    provider: definition.model.providerId,
    modelId: definition.model.modelId,
  })?.model
  try {
    if (!model || model.definition.dimensions !== definition.model.definition.dimensions)
      throw createSixbError(
        "vector.model_unavailable",
        "[Sixb] Vector indexing requires the profile's configured embedding model."
      )
    const result = await model.embed({ texts: [prepared.text], signal })
    const values = indexingVector(result, definition.model.definition.dimensions)
    if (
      !(await indexing.update({
        projectId,
        id,
        expectedStatus: "running",
        status: "ready",
        values,
        availableAt: new Date().toISOString(),
      }))
    )
      return
  } catch (error) {
    if (
      !started &&
      isSixbError(error) &&
      (error.code === "ai.usage_limit_exceeded" || error.code === "ai.usage_limit_unavailable")
    ) {
      const availableAt = retryAt(error.details)
      await indexing.update({
        projectId,
        id,
        expectedStatus: "pending",
        status: "pending",
        availableAt,
      })
      throw new VectorIndexingDeferred(availableAt)
    }
    if (!started && signal.aborted) throw error
    const failure =
      error instanceof EmbeddingModelResponseError
        ? createSixbError("vector.response_invalid", "[Sixb] Invalid embedding response.", {
            cause: error,
          })
        : error
    await fail(runtime, indexing, { ...work, status: started ? "running" : "pending" }, failure)
    return
  }
}

function indexingVector(result: EmbeddingModelResult, dimensions: number): readonly number[] {
  try {
    if (!Array.isArray(result?.vectors) || result.vectors.length !== 1) {
      throw new Error("[Sixb] Expected exactly one embedding vector.")
    }
    return normalizeVector(result.vectors[0]!, dimensions)
  } catch (cause) {
    throw createSixbError("vector.response_invalid", "[Sixb] Invalid embedding response.", {
      cause,
    })
  }
}

async function prepare(
  runtime: SixbHostContext,
  work: VectorIndexingWork
): Promise<PreparedObjectVector | null> {
  const profile = runtime.ontology.getObjectTypeById(work.ref.objectTypeId)?.search?.vectors?.[
    work.profile
  ]
  if (!profile || vectorConfiguration(profile) !== work.configuration) return null
  const row = await runtime.storage.objects.getByPrimaryId({
    projectId: runtime.projectId,
    ...work.ref,
  })
  if (!row) return null
  const sources = vectorSources(profile.source, row.properties)
  if (sources.sourceFingerprint !== work.sourceFingerprint) return null
  const current = (
    await runtime.storage.ontology.vectors!.list({ projectId: runtime.projectId, ref: work.ref })
  ).find((entry) => entry.profile === work.profile)
  if (
    current?.configuration === work.configuration &&
    current.sourceFingerprint === work.sourceFingerprint
  )
    return null
  return {
    projectId: runtime.projectId,
    ref: work.ref,
    profile: work.profile,
    configuration: work.configuration,
    ...sources,
    expectedObject: {
      ref: work.ref,
      exists: true,
      version: row.version,
      lastCommitId: row.lastCommitId,
    },
    expectedVectorCommitId: current?.lastCommitId ?? null,
  }
}

async function storeVector(
  runtime: SixbHostContext,
  materializer: OntologyMaterializerContract,
  work: VectorIndexingWork,
  scope: ExecutionScope,
  signal: AbortSignal
): Promise<void> {
  // Unrelated property changes renew the object fence without repeating a paid inference.
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    const prepared = await prepare(runtime, work)
    if (!prepared) {
      await runtime.storage.ontology.vectorIndexing!.remove({
        projectId: runtime.projectId,
        id: work.id,
      })
      return
    }
    try {
      await materializer.edits.commit({
        scope,
        input: {
          mode: "atomic",
          source: { kind: "runtime", requestId: randomUUID() },
          operations: [],
          vectorWrites: [{ input: prepared, values: work.values! }],
          expectedObjects: [prepared.expectedObject],
          expectedLinks: [],
          expectedLinkScopes: [],
        },
      })
      await runtime.storage.ontology.vectorIndexing!.remove({
        projectId: runtime.projectId,
        id: work.id,
      })
      return
    } catch (error) {
      if (!(error instanceof MaterializationConflictError)) throw error
      const current = await runtime.storage.ontology.vectorIndexing!.get({
        projectId: runtime.projectId,
        id: work.id,
      })
      if (!current) return
    }
  }
  throw new VectorIndexingDeferred(new Date(Date.now() + 1000).toISOString())
}

async function indexingScope(
  runtime: SixbHostContext,
  work: VectorIndexingWork
): Promise<ExecutionScope> {
  const operation = { type: "ontology.indexVectors", indexingId: work.id } as const
  const execution: ExecutionContext = {
    id: `exec_vector_${work.id}`,
    projectId: runtime.projectId,
    executor: { type: "kernel", operation },
    source: { type: "ontologyCommit", commitId: work.sourceCommitId },
    correlationId: `vector_${work.id}`,
  }
  const authorization = createKernelRuntimeAuthorization({ execution, operation })
  await ensureExecutionRecord(runtime.storage.executions, {
    ...executionRecordInputFromRuntime({ execution, runtimeAuthorization: authorization }),
    requesterGroupIds: [],
  })
  return { execution, authorization }
}

async function fail(
  runtime: SixbHostContext,
  indexing: OntologyVectorIndexingStorage,
  work: VectorIndexingWork,
  error: unknown
): Promise<void> {
  const failure = captureSixbFailure(error, {
    allowedCodes: VECTOR_INDEXING_FAILURE_CODES,
    defaultCode: "internal.unexpected",
  })
  const changed = await indexing.update({
    projectId: runtime.projectId,
    id: work.id,
    expectedStatus: work.status,
    status: "failed",
    availableAt: new Date().toISOString(),
    error: failure,
  })
  if (changed)
    reportVectorIndexingFailure(runtime, error, {
      projectId: runtime.projectId,
      indexingId: work.id,
      failure,
      ...work.ref,
      profile: work.profile,
    })
}

function retryAt(details: unknown): string {
  const resetAt =
    details && typeof details === "object" && "resetAt" in details ? details.resetAt : undefined
  const timestamp = typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN
  return new Date(
    Math.max(Date.now() + 60_000, Number.isFinite(timestamp) ? timestamp : 0)
  ).toISOString()
}

export class VectorIndexingDeferred extends Error {
  constructor(readonly availableAt: string) {
    super("[Sixb] Vector indexing is deferred.")
  }
}
