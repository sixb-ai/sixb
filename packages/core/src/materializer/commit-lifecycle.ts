import { isStorageSerializationFailure, type Storage } from "../storage"
import { MaterializationConflictError, MaterializationValidationError } from "./errors"
import type { FixedCommitIdentity } from "./identity"
import type { MaterializerContext, MaterializerStorage } from "./materializer-context"
import type { EditCommitResult, ProjectionCommitResult, TelemetryCommitResult } from "./types"

export function requireOntologyStorage(storage: Storage): MaterializerStorage {
  if (!storage.ontology) {
    throw new MaterializationValidationError("Storage does not provide ontology capabilities.")
  }
  return storage as MaterializerStorage
}

export async function replayCommit<
  TResult extends EditCommitResult | ProjectionCommitResult | TelemetryCommitResult,
>(
  context: Pick<MaterializerContext, "projectId" | "storage">,
  identity: FixedCommitIdentity,
  storage: MaterializerStorage = context.storage
): Promise<TResult | null> {
  const existing = await storage.ontology.commits.getByIdempotencyKey({
    projectId: context.projectId,
    idempotencyKey: identity.idempotencyKey,
  })
  if (!existing) return null
  if (existing.requestHash !== identity.requestHash) {
    throw new MaterializationConflictError(
      "idempotency",
      `Idempotency key '${identity.idempotencyKey}' was reused with different intent.`
    )
  }
  return { ...structuredClone(existing.result), created: false } as TResult
}

export async function withSerializationRetry<T>(
  context: Pick<MaterializerContext, "maxSerializationRetries" | "onSerializationRetry">,
  run: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (!isStorageSerializationFailure(error) || attempt >= context.maxSerializationRetries) {
        throw error
      }
      context.onSerializationRetry?.(attempt + 1, error)
    }
  }
}

export async function attachRunReplay(
  storage: Storage,
  projectId: string,
  kind: "action" | "projection",
  runId: string,
  commitId: string
): Promise<void> {
  const runStorage = kind === "action" ? storage.actionRuns : storage.projectionRuns
  await runStorage?.recordMaterializationReplay?.(projectId, runId, commitId)
}

export async function attachRunReplayTransaction(
  context: Pick<MaterializerContext, "projectId" | "storage">,
  kind: "action" | "projection",
  runId: string,
  commitId: string
): Promise<void> {
  await context.storage.transaction(
    (tx) => attachRunReplay(tx, context.projectId, kind, runId, commitId),
    { isolation: "serializable" }
  )
}
