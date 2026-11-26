import type { DatasetVersionRef } from "../../lake-storage/types"

/**
 * A slice production cut for a branch: the dataset versions it holds, and the exact files it
 * serves for them. The list is the boundary: the file route serves nothing else, and production's
 * retention deletes none of those files while the slice is live.
 *
 * Recorded before the cut writes anything, so that nothing it writes is ever unrecorded. Live from
 * then until 14 days after its last token expired (or after it was created, with no token).
 */
export interface LakeSliceRecord {
  readonly id: string
  readonly projectId: string
  /** The person it was cut for, who opened the branch. */
  readonly userId: string
  readonly branch: string
  /** The point in the lake's history it was cut at. */
  readonly point: string
  readonly versions: readonly DatasetVersionRef[]
  /** The paths the file route serves for it. */
  readonly files: readonly string[]
  readonly createdAt: Date
  /** When its last token expires. Absent before its first token. */
  readonly lastTokenExpiresAt?: Date
  /**
   * SHA-256 of the branch's credential, which reads production only as its person, only for the
   * branch: its objects' files and its lake. Absent for a slice cut for no branch credential.
   */
  readonly credentialHash?: string
  /**
   * The groups the copy that made the credential read with, which an access token may narrow: the
   * credential never reads with more, whatever groups its person joins since.
   */
  readonly credentialGroupIds?: readonly string[]
  /**
   * What its person signed in with to take the copy: the credential reads nothing once that is
   * revoked or signed out. Absent for a copy production took for its person itself, such as a
   * hosted branch's.
   */
  readonly credentialMintedBy?: LakeSliceCredentialMinter
  /**
   * When the branch confirmed it holds its copy whole. A slice with a credential that no branch
   * confirmed is the copy of a branch that never got it: it lives only a short grace.
   */
  readonly receivedAt?: Date
}

/** The session or personal access token a branch credential was taken with. */
export interface LakeSliceCredentialMinter {
  readonly type: "session" | "accessToken"
  readonly id: string
}

/** One token a branch reads a slice's files with. SHA-256 only: the token is never stored. */
export interface LakeSliceGrantRecord {
  readonly id: string
  readonly projectId: string
  readonly tokenHash: string
  readonly sliceId: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface LakeSliceRef {
  readonly projectId: string
  readonly id: string
}

export interface ListLiveLakeSlicesInput {
  readonly projectId: string
  /** A slice whose last token expired (or, with none, that was created) before this is not live. */
  readonly liveAfter: Date
}

export interface DeleteExpiredLakeSlicesInput {
  readonly projectId: string
  readonly before: Date
  readonly limit: number
}

/** Persistence only: cutting, token checks and expiry rules live in Core. */
export interface LakeSliceStorage {
  /** `(projectId, id)` is unique. */
  create(record: LakeSliceRecord): Promise<void>
  get(input: LakeSliceRef): Promise<LakeSliceRecord | null>
  /** Deletes a slice and its grants, such as one whose cut failed. */
  delete(input: LakeSliceRef): Promise<void>
  /** Records a token for the slice and keeps the later of its expiry and the slice's last one. */
  createGrant(record: LakeSliceGrantRecord): Promise<void>
  /** Records when the branch confirmed it holds its copy, keeping the first time. */
  markReceived(input: LakeSliceRef & { readonly at: Date }): Promise<void>
  /** The slice a branch credential belongs to, live or not: the caller decides. */
  findByCredentialHash(input: {
    readonly projectId: string
    readonly credentialHash: string
  }): Promise<LakeSliceRecord | null>
  /** Returns expired grants too; the caller decides whether one still serves. */
  findGrantByTokenHash(input: {
    readonly projectId: string
    readonly tokenHash: string
  }): Promise<LakeSliceGrantRecord | null>
  /** Slices live after `liveAfter`, oldest first. */
  listLive(input: ListLiveLakeSlicesInput): Promise<readonly LakeSliceRecord[]>
  /**
   * Deletes up to `limit` slices no longer live at `before`, with their grants, and grants that
   * expired before it. Returns how many slices it deleted.
   */
  deleteExpired(input: DeleteExpiredLakeSlicesInput): Promise<number>
}
