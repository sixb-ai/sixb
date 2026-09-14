import type { ExpectedObjectRevision, OntologyObjectRef } from "./model"

/** Internal observation captured before embedding and fenced by the atomic vector write. */
export interface PreparedObjectVector {
  readonly projectId: string
  readonly ref: OntologyObjectRef
  readonly profile: string
  readonly configuration: string
  readonly text: string
  readonly sourceFingerprint: string
  readonly expectedObject: Extract<ExpectedObjectRevision, { exists: true }>
  readonly expectedVectorCommitId: string | null
}

export interface ObjectVectorWrite {
  readonly input: PreparedObjectVector
  readonly values: readonly number[]
}
