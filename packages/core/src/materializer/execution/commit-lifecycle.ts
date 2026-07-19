import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  EditCommitResult,
  ProjectionCommitResult,
  TelemetryCommitResult,
} from "../../materialization/model"
import { isStorageSerializationFailure, type Storage } from "../../storage"
import type { OntologyCommitRecord } from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
import type { CommitIdentity } from "../shared/identity"

export function requireOntologyStorage(storage: Storage): MaterializerStorage {
  if (!storage.ontology) {
    throw new MaterializationValidationError("Storage does not provide ontology capabilities.")
  }
  return storage as MaterializerStorage
}

export async function replayCommitRecord(
  context: Pick<MaterializerContext, "projectId" | "storage">,
  identity: CommitIdentity,
  storage: MaterializerStorage = context.storage
): Promise<OntologyCommitRecord | null> {
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
  return existing
}

export async function replayCommit<
  TResult extends EditCommitResult | ProjectionCommitResult | TelemetryCommitResult,
>(
  context: Pick<MaterializerContext, "projectId" | "storage">,
  identity: CommitIdentity,
  storage: MaterializerStorage = context.storage
): Promise<TResult | null> {
  const existing = await replayCommitRecord(context, identity, storage)
  if (!existing) return null
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
