import type { ActionSubject } from "../../actions"
import type { SecurityContext } from "../../auth"
import type { EditBatchInput, EditCommitDiff } from "../../edits"
import type { OntologyRegistry } from "../../ontology/registry"

export interface CommitEditBatchInput {
  readonly projectId: string
  readonly runId: string
  readonly actionId: string
  readonly subject: ActionSubject
  readonly ontology: Pick<
    OntologyRegistry,
    "resolveObjectType" | "getPrimaryPropertyId" | "getValueTypesById" | "isValidLinkTarget"
  >
  readonly batch: EditBatchInput
  readonly committedAt?: Date
  readonly securityContext?: SecurityContext
  readonly idempotencyKey?: string
}

export interface EditCommitResult {
  readonly diff: EditCommitDiff
  readonly committedAt: Date
  readonly created: boolean
}

export interface EditStorage {
  commit(input: CommitEditBatchInput): Promise<EditCommitResult>
}
