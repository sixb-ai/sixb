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
  listBatch(input: {
    projectId: string
    refs: readonly OntologyObjectRef[]
  }): Promise<readonly ObjectVectorState[]>
  removeBatch(input: {
    session: MaterializationSession
    projectId: string
    entries: readonly { ref: OntologyObjectRef; profile: string; expectedCommitId: string }[]
  }): Promise<void>
  write(input: {
    session: MaterializationSession
    projectId: string
    value: StoredObjectVector
    expectedCommitId: string | null
  }): Promise<void>
  /** Write a validated set inside the materialization transaction; any conflict aborts it. */
  writeBatch(input: {
    session: MaterializationSession
    projectId: string
    entries: readonly { value: StoredObjectVector; expectedCommitId: string | null }[]
  }): Promise<void>
  remove(input: {
    session: MaterializationSession
    projectId: string
    ref: OntologyObjectRef
    profile: string
    expectedCommitId: string
  }): Promise<void>
}
