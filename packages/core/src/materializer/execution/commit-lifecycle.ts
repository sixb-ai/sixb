import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  EditCommitResult,
  ProjectionCommitResult,
  TelemetryCommitResult,
} from "../../materialization/model"
import type {
  ActionRunMaterializationBookkeeping,
  ProjectionRunMaterializationReplay,
} from "../../storage"
import {
  isActionMaterializationRunStorage,
  isProjectionMaterializationRunStorage,
  isStorageSerializationFailure,
  type Storage,
} from "../../storage"
import type { MaterializerContext, MaterializerStorage } from "../context"
import type { CommitIdentity } from "../shared/identity"

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
  identity: CommitIdentity,
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
  replay: ActionRunMaterializationBookkeeping | ProjectionRunMaterializationReplay
): Promise<void> {
  if (replay.kind === "action") {
    if (!isActionMaterializationRunStorage(storage.actionRuns)) {
      throw new MaterializationValidationError(
        "Storage does not provide Action run capabilities required by this commit."
      )
    }
    await storage.actionRuns.recordMaterializationReplay(projectId, replay)
    return
  }
  if (!isProjectionMaterializationRunStorage(storage.projectionRuns)) {
    throw new MaterializationValidationError(
      "Storage does not provide projection run capabilities required by this commit."
    )
  }
  await storage.projectionRuns.recordMaterializationReplay(projectId, replay)
}

export async function attachRunReplayTransaction(
  context: Pick<
    MaterializerContext,
    "projectId" | "storage" | "maxSerializationRetries" | "onSerializationRetry"
  >,
  replay: ActionRunMaterializationBookkeeping | ProjectionRunMaterializationReplay
): Promise<void> {
  await withSerializationRetry(context, () =>
    context.storage.transaction((tx) => attachRunReplay(tx, context.projectId, replay), {
      isolation: "serializable",
    })
  )
}
