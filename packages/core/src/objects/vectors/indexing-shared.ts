import { randomUUID } from "node:crypto"
import { reportVectorIndexingFailure } from "../../error-reporting/capability"
import { captureSixbFailure } from "../../errors/internal"
import { createKernelRuntimeAuthorization } from "../../execution/authorization"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../../execution/durable"
import type { ExecutionContext, ExecutionScope } from "../../execution/types"
import { MaterializationConflictError } from "../../materialization/errors"
import type { ObjectVectorWrite, PreparedObjectVector } from "../../materialization/vectors"
import type { OntologyMaterializerContract } from "../../materializer/materializer"
import type { SixbHostContext } from "../../runtime/types"
import {
  type OntologyVectorIndexingStorage,
  VECTOR_INDEXING_FAILURE_CODES,
  type VectorIndexingWork,
} from "../../storage/ontology/vector-indexing"
import { vectorConfiguration, vectorSources } from "./profile"

/** Return null when the requested representation is obsolete or already stored. */
export async function prepare(
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

  const storedVectors = await runtime.storage.ontology.vectors!.list({
    projectId: runtime.projectId,
    ref: work.ref,
  })
  const currentVector = storedVectors.find((entry) => entry.profile === work.profile)
  const alreadyIndexed =
    currentVector?.configuration === work.configuration &&
    currentVector.sourceFingerprint === work.sourceFingerprint

  if (alreadyIndexed) return null

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
    expectedVectorCommitId: currentVector?.lastCommitId ?? null,
  }
}

export async function storeVector(
  runtime: SixbHostContext,
  materializer: OntologyMaterializerContract,
  work: VectorIndexingWork,
  scope: ExecutionScope,
  signal: AbortSignal
): Promise<void> {
  const indexing = runtime.storage.ontology.vectorIndexing!
  const identity = { projectId: runtime.projectId, id: work.id }

  // Unrelated property changes renew the object fence without repeating a paid inference.
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    const prepared = await prepare(runtime, work)

    if (!prepared) {
      await indexing.remove(identity)
      return
    }

    try {
      await commitPreparedVectors(materializer, scope, [{ input: prepared, values: work.values! }])
      await indexing.remove(identity)
      return
    } catch (error) {
      if (!(error instanceof MaterializationConflictError)) throw error

      const currentWork = await indexing.get(identity)
      if (!currentWork) return
    }
  }

  throw new VectorIndexingDeferred(new Date(Date.now() + 1000).toISOString())
}

export async function commitPreparedVectors(
  materializer: OntologyMaterializerContract,
  scope: ExecutionScope,
  writes: readonly ObjectVectorWrite[]
): Promise<void> {
  await materializer.edits.commit({
    scope,
    input: {
      mode: "atomic",
      source: { kind: "runtime", requestId: randomUUID() },
      operations: [],
      vectorWrites: writes,
      expectedObjects: writes.map((write) => write.input.expectedObject),
      expectedLinks: [],
      expectedLinkScopes: [],
    },
  })
}

export async function indexingScope(
  runtime: SixbHostContext,
  work: VectorIndexingWork,
  indexingId = work.id
): Promise<ExecutionScope> {
  const operation = { type: "ontology.indexVectors", indexingId } as const
  const execution: ExecutionContext = {
    id: `exec_vector_${indexingId}`,
    projectId: runtime.projectId,
    executor: { type: "kernel", operation },
    source: { type: "ontologyCommit", commitId: work.sourceCommitId },
    correlationId: `vector_${indexingId}`,
  }
  const authorization = createKernelRuntimeAuthorization({ execution, operation })

  await ensureExecutionRecord(runtime.storage.executions, {
    ...executionRecordInputFromRuntime({ execution, runtimeAuthorization: authorization }),
    requesterGroupIds: [],
  })

  return { execution, authorization }
}

export async function fail(
  runtime: SixbHostContext,
  indexing: OntologyVectorIndexingStorage,
  work: VectorIndexingWork,
  error: unknown
): Promise<void> {
  const failure = captureSixbFailure(error, {
    allowedCodes: VECTOR_INDEXING_FAILURE_CODES,
    defaultCode: "internal.unexpected",
  })

  const recorded = await indexing.update({
    projectId: runtime.projectId,
    id: work.id,
    expectedStatus: work.status,
    status: "failed",
    availableAt: new Date().toISOString(),
    error: failure,
  })

  if (!recorded) return

  reportVectorIndexingFailure(runtime, error, {
    projectId: runtime.projectId,
    indexingId: work.id,
    failure,
    ...work.ref,
    profile: work.profile,
  })
}

export function retryAt(details: unknown): string {
  const resetAt =
    details && typeof details === "object" && "resetAt" in details ? details.resetAt : undefined
  const resetTimestamp = typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN

  const minimumRetryTimestamp = Date.now() + 60_000
  const budgetResetTimestamp = Number.isFinite(resetTimestamp) ? resetTimestamp : 0
  const retryTimestamp = Math.max(minimumRetryTimestamp, budgetResetTimestamp)

  return new Date(retryTimestamp).toISOString()
}

export class VectorIndexingDeferred extends Error {
  constructor(readonly availableAt: string) {
    super("[Sixb] Vector indexing is deferred.")
  }
}
