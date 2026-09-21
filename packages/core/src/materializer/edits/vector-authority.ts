import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type { OntologyEditCommit } from "../../materialization/model"
import type { ObjectVectorWrite } from "../../materialization/vectors"
import type { Storage } from "../../storage"
import type { VectorIndexingWork } from "../../storage/ontology/vector-indexing"
import type { MaterializerExecution } from "../execution/scope"

/** Kernel indexing can publish one persisted result, never change business data. */
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
    input.vectorWrites?.length !== 1 ||
    input.expectedObjects.length !== 1 ||
    input.expectedLinks.length ||
    input.expectedLinkScopes.length
  ) {
    throw new MaterializationValidationError(
      "Vector indexing authority only permits a single vector write."
    )
  }
  const work = await storage.ontology.vectorIndexing?.get({
    projectId,
    id: executor.operation.indexingId,
  })
  if (!work || work.status !== "ready") {
    throw new MaterializationConflictError(
      "effective-state",
      "Vector indexing work is no longer ready."
    )
  }
  const source = execution.scope.execution.source
  if (
    source.type !== "ontologyCommit" ||
    source.commitId !== work.sourceCommitId ||
    !matchesStoredResult(input.vectorWrites[0]!, work)
  ) {
    throw new MaterializationValidationError(
      "Vector indexing authority only permits its current prepared representation."
    )
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
