import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type { OntologyEditCommit } from "../../materialization/model"
import { objectRefKey } from "../../materialization/refs"
import type { ObjectVectorWrite } from "../../materialization/vectors"
import type { Storage } from "../../storage"
import type { VectorIndexingWork } from "../../storage/ontology/vector-indexing"
import type { MaterializerExecution } from "../execution/scope"

/** Kernel indexing can publish only its persisted results, never change business data. */
export async function authorizeVectorIndexingCommit(
  storage: Storage,
  projectId: string,
  input: OntologyEditCommit,
  execution: MaterializerExecution
): Promise<boolean> {
  const executor = execution.scope.execution.executor
  if (executor.type !== "kernel" || executor.operation.type !== "ontology.indexVectors")
    return false
  if (
    input.mode !== "atomic" ||
    input.source.kind !== "runtime" ||
    input.operations.length ||
    !input.vectorWrites?.length ||
    input.expectedLinks.length ||
    input.expectedLinkScopes.length
  ) {
    throw new MaterializationValidationError(
      "Vector indexing authority only permits its persisted vector writes."
    )
  }
  const writes = input.vectorWrites!
  const refs = new Set(writes.map((write) => objectRefKey(write.input.ref)))
  if (
    input.expectedObjects.length !== refs.size ||
    input.expectedObjects.some((expected) => !refs.has(objectRefKey(expected.ref)))
  ) {
    throw new MaterializationValidationError(
      "Vector indexing must fence exactly its written objects."
    )
  }

  const indexing = storage.ontology.vectorIndexing
  const indexingId = executor.operation.indexingId
  const single = await indexing?.get({ projectId, id: indexingId })
  if (single && writes.length !== 1) {
    throw new MaterializationValidationError(
      "Individual indexing authority only permits one vector write."
    )
  }

  // Multi-object publication reads membership/results once, not once per object.
  let members: readonly VectorIndexingWork[]
  if (single) {
    members = [single]
  } else if (writes.length === 1) {
    const member = await indexing?.getBatchMember({
      projectId,
      batchId: indexingId,
      ref: writes[0]!.input.ref,
      profile: writes[0]!.input.profile,
    })
    members = member ? [member] : []
  } else {
    members = (await indexing?.getBatch({ projectId, batchId: indexingId })) ?? []
  }

  const byProfile = new Map(
    members.map((work) => [JSON.stringify([objectRefKey(work.ref), work.profile]), work])
  )
  const source = execution.scope.execution.source

  for (const write of writes) {
    const work = byProfile.get(JSON.stringify([objectRefKey(write.input.ref), write.input.profile]))
    if (!work || work.status !== "ready") {
      throw new MaterializationConflictError(
        "effective-state",
        "Vector indexing work is no longer ready."
      )
    }
    if (
      source.type !== "ontologyCommit" ||
      source.commitId !== work.sourceCommitId ||
      !matchesStoredResult(write, work)
    ) {
      throw new MaterializationValidationError(
        "Vector indexing authority only permits its current prepared representation."
      )
    }
  }
  return true
}

function matchesStoredResult(write: ObjectVectorWrite, work: VectorIndexingWork): boolean {
  const prepared = write.input
  return (
    prepared.ref.objectTypeId === work.ref.objectTypeId &&
    prepared.ref.primaryId === work.ref.primaryId &&
    prepared.profile === work.profile &&
    prepared.configuration === work.configuration &&
    prepared.sourceFingerprint === work.sourceFingerprint &&
    work.values !== undefined &&
    work.values.length === write.values.length &&
    work.values.every((value, index) => value === write.values[index])
  )
}
