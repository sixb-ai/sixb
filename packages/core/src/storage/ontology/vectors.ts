import type { OntologyObjectRef } from "../../materialization/model"
import type { MaterializationSession } from "./materializations"

export interface ObjectVectorState {
  readonly ref: OntologyObjectRef
  readonly profile: string
  readonly configuration: string
  readonly source: readonly string[]
  readonly sourceFingerprint: string
  readonly lastCommitId: string
}

export interface StoredObjectVector extends ObjectVectorState {
  readonly values: readonly number[]
}

/** Transactional derived state. Mutations must run inside an ontology materialization transaction. */
export interface OntologyVectorStorage {
  list(input: { projectId: string; ref: OntologyObjectRef }): Promise<readonly ObjectVectorState[]>
  write(input: {
    session: MaterializationSession
    projectId: string
    value: StoredObjectVector
    expectedCommitId: string | null
  }): Promise<void>
  remove(input: {
    session: MaterializationSession
    projectId: string
    ref: OntologyObjectRef
    profile: string
    expectedCommitId: string
  }): Promise<void>
}
