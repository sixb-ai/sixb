/**
 * Thrown when a storage lookup by primary ID finds no matching object.
 * Carries structured context so callers can discriminate without string parsing.
 */
export class ObjectNotFoundError extends Error {
  readonly name = "ObjectNotFoundError"

  constructor(
    readonly objectTypeId: string,
    readonly primaryId: string,
    readonly context: string
  ) {
    super(`[Sixb] ${context}: ${objectTypeId}:${primaryId}`)
  }
}

export class ObjectStorageError extends Error {
  readonly name = "ObjectStorageError"
}

export class StorageTransactionError extends Error {
  readonly name = "StorageTransactionError"
}

/** Identity of an object targeted by an edit-commit plan. */
export interface EditCommitObjectRef {
  readonly objectTypeId: string
  readonly primaryId: string
}

/** Identity of a link targeted by an edit-commit plan. */
export interface EditCommitLinkRef {
  readonly source: EditCommitObjectRef
  readonly linkId: string
  readonly target: EditCommitObjectRef
}

function objectRefLabel(ref: EditCommitObjectRef): string {
  return `${ref.objectTypeId}:${ref.primaryId}`
}

function linkRefLabel(ref: EditCommitLinkRef): string {
  return `${ref.source.objectTypeId}:${ref.source.primaryId}:${ref.linkId}:${ref.target.objectTypeId}:${ref.target.primaryId}`
}

/*
 * Edit-commit conflict errors, shared by every storage provider.
 *
 * Applying an edit-commit plan can fail when the row state diverged from the plan: a `create` whose
 * row already exists, or an `update` whose row is missing (the plan was built against a snapshot a
 * concurrent commit has since changed). Every provider — in-memory, SQLite and Postgres — surfaces
 * these through the same {@link ObjectStorageError} type and the same `[Sixb] Edit commit cannot …`
 * message shape (carrying the offending entity's identity), so callers can classify the failure
 * uniformly instead of parsing provider-specific text or receiving a raw driver constraint error.
 */
export function editCommitObjectCreateConflict(ref: EditCommitObjectRef): ObjectStorageError {
  return new ObjectStorageError(
    `[Sixb] Edit commit cannot create existing object '${objectRefLabel(ref)}'.`
  )
}

export function editCommitObjectUpdateMissing(ref: EditCommitObjectRef): ObjectStorageError {
  return new ObjectStorageError(
    `[Sixb] Edit commit cannot update missing object '${objectRefLabel(ref)}'.`
  )
}

export function editCommitLinkCreateConflict(ref: EditCommitLinkRef): ObjectStorageError {
  return new ObjectStorageError(
    `[Sixb] Edit commit cannot create existing link '${linkRefLabel(ref)}'.`
  )
}

export function editCommitLinkUpdateMissing(ref: EditCommitLinkRef): ObjectStorageError {
  return new ObjectStorageError(
    `[Sixb] Edit commit cannot update missing link '${linkRefLabel(ref)}'.`
  )
}
