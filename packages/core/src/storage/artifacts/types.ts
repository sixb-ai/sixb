import type { ArtifactKind } from "../../artifacts/kinds"
import type { ArtifactOutline } from "../../artifacts/outline"
import type { ArtifactReference } from "../../artifacts/references"
import type { ArtifactThemeMode } from "../../artifacts/theme"
import type { Principal } from "../../auth"
import type { FileRef } from "../../blob-storage"

export type { ArtifactKind, ArtifactOutline, ArtifactReference, ArtifactThemeMode }

/**
 * A versioned document, sheet, deck, or file. Its kind never changes. Its latest version is open
 * until someone creates a version, which freezes it: writes replace an open version's content, and
 * the first write after a freeze opens the next version.
 */
export interface ArtifactRecord {
  readonly projectId: string
  readonly id: string
  readonly kind: ArtifactKind
  /** The latest version's title. */
  readonly title: string
  /** Who created the artifact; reading and publishing are decided from it. */
  readonly owner: Principal
  readonly latestVersion: number
  /**
   * Counts the artifact's changes: a write, a freeze, a restore. It only grows, so content read at
   * one revision is that revision's for good. Always the latest version's revision.
   */
  readonly revision: number
  readonly createdAt: Date
  /** When it last changed. */
  readonly updatedAt: Date
  /**
   * The content as a Yjs document: what everyone editing a canvas live shares, and what every
   * write to it merges into. A write that changes the content stores one with it; one that stores
   * none leaves this one behind, at the revision whose content it holds.
   */
  readonly document?: ArtifactDocument
}

/** An artifact's Yjs document, encoded whole in a blob, and the revision whose content it holds. */
export interface ArtifactDocument {
  readonly file: FileRef
  /** The artifact's revision when it was stored, or when a freeze kept its content since. */
  readonly revision: number
}

/** One file of a version, at its path inside the artifact. */
export interface ArtifactFile {
  /** Relative, with `/` separators and no `.` or `..` segments. */
  readonly path: string
  readonly file: FileRef
}

/**
 * Where a version's content was last written from: an Agent turn in a thread. Writing from one
 * shares the artifact in that thread.
 */
export interface ArtifactOrigin {
  readonly threadId: string
  readonly runId: string
}

/**
 * One version. While it is open, the latest, each write replaces its content; once frozen it never
 * changes. An artifact has at most one open version.
 */
export interface ArtifactVersionRecord {
  readonly projectId: string
  readonly artifactId: string
  readonly version: number
  /**
   * The artifact's revision when this version last changed. The latest version's is the
   * artifact's, so it moves with every change to the artifact while the version is the latest.
   */
  readonly revision: number
  readonly title: string
  /** The path of the file the kind renders from, one of `files`. */
  readonly entry: string
  readonly files: readonly ArtifactFile[]
  readonly outline: ArtifactOutline
  readonly references: readonly ArtifactReference[]
  /** Who last wrote its content. */
  readonly author: Principal
  /** Where its content was last written from. */
  readonly origin?: ArtifactOrigin
  /** When the version was opened, by its first write. */
  readonly createdAt: Date
  /** When its content was last written. */
  readonly updatedAt: Date
  /** When someone created the version, which froze it; absent while it is open. */
  readonly frozenAt?: Date
  /** Who created it, with `frozenAt`. */
  readonly frozenBy?: Principal
}

/** What a write puts in a version: its content, who wrote it, and when (`updatedAt`). */
export type ArtifactVersionInput = Omit<
  ArtifactVersionRecord,
  "projectId" | "artifactId" | "version" | "revision" | "createdAt" | "frozenAt" | "frozenBy"
>

export interface CreateArtifactInput {
  readonly projectId: string
  readonly id: string
  readonly kind: ArtifactKind
  readonly owner: Principal
  /** Becomes version 1, open, at revision 1. */
  readonly version: ArtifactVersionInput
  /** The Agent turn that creates it: a retry of the turn deletes it, unless it changed since. */
  readonly turnRunId?: string
  /** The content as a Yjs document: the artifact's {@link ArtifactRecord.document}. */
  readonly document?: FileRef
}

export interface PublishArtifactVersionInput {
  readonly projectId: string
  readonly artifactId: string
  /** Must be the artifact's kind. */
  readonly kind: ArtifactKind
  readonly version: ArtifactVersionInput
  /**
   * The revision this content was made from. When the artifact is at another, the write fails
   * with `artifact_moved` rather than replace changes it never saw.
   */
  readonly baseRevision?: number
  /**
   * The Agent turn that writes: its own run, or its parent's for a sub-agent. The turn's first
   * write keeps a restore point of what it replaces, and a retry of the turn undoes its writes.
   */
  readonly turnRunId?: string
  /** The content as a Yjs document; without it, the artifact's stays behind. */
  readonly document?: FileRef
}

export interface FreezeArtifactVersionInput {
  readonly projectId: string
  readonly artifactId: string
  /** The revision the caller saw: past it, `artifact_moved`, so nobody freezes content unseen. */
  readonly baseRevision?: number
  readonly frozenAt: Date
  /** Who creates the version. */
  readonly frozenBy: Principal
}

/**
 * What an artifact's latest version held before a change that can be undone: an Agent turn's
 * first write to it, or a restore. It is not a version, and is kept by the revision it holds.
 */
export interface ArtifactRestorePointRecord {
  readonly projectId: string
  readonly artifactId: string
  /** The artifact's revision whose content it holds: one restore point per revision at most. */
  readonly revision: number
  /** The version it was taken of, and whether that version was frozen then. */
  readonly version: number
  readonly frozen: boolean
  readonly title: string
  readonly entry: string
  readonly files: readonly ArtifactFile[]
  readonly outline: ArtifactOutline
  readonly references: readonly ArtifactReference[]
  /** Who had last written that content, from where, and when. */
  readonly author: Principal
  readonly origin?: ArtifactOrigin
  readonly updatedAt: Date
  /** What it was taken before: an Agent turn's first write, or a restore. */
  readonly reason: ArtifactRestorePointReason
  /** With `turn`: the turn's run. */
  readonly turnRunId?: string
  /** When it was taken. */
  readonly createdAt: Date
}

export type ArtifactRestorePointReason = "turn" | "restore"

export interface GetArtifactRestorePointInput {
  readonly projectId: string
  readonly artifactId: string
  readonly revision: number
}

export interface RestoreArtifactInput {
  readonly projectId: string
  readonly artifactId: string
  /** The restore point's revision. */
  readonly revision: number
  /** The revision the caller saw: past it, `artifact_moved`. */
  readonly baseRevision?: number
  /** Who restores: the restored content's author from now on. */
  readonly author: Principal
  readonly restoredAt: Date
  /** The restored content as a Yjs document; without it, the artifact's stays behind. */
  readonly document?: FileRef
}

/** An artifact an Agent turn wrote, and the artifact's revision after the turn's last write. */
export interface ArtifactTurnWriteRecord {
  readonly artifactId: string
  /** The turn created the artifact. */
  readonly created: boolean
  readonly revision: number
  /**
   * How many changes the turn made to it, creating it included: each moves the revision by one,
   * so a change by anyone else between two of them shows as a revision past the turn's count.
   */
  readonly writes: number
}

export interface ArtifactTurnInput {
  readonly projectId: string
  /** The turn's run: a conversation's, never a sub-agent's. */
  readonly turnRunId: string
}

export interface UndoArtifactTurnInput extends ArtifactTurnInput {
  /**
   * Whom the turn answered. An artifact the turn created is kept when anyone else commented on it;
   * their comments, and the Agent's for them, don't keep it.
   */
  readonly requester?: Principal
  /**
   * The Yjs document of each artifact put back, by id, as its turn's restore point holds it: made
   * at the revision the turn's last write left, which is the only one an artifact is put back
   * from. An artifact put back without one leaves its document behind, for the next reader to
   * bring up to the content.
   */
  readonly documents?: Readonly<Record<string, FileRef>>
}

/** What undoing a turn's writes changed. */
export interface UndoneArtifactTurn {
  /** The artifacts put back as they were before the turn, each at a new revision. */
  readonly restored: readonly PublishedArtifactVersion[]
  /** The ids of the artifacts the turn created, deleted. */
  readonly deleted: readonly string[]
}

export interface PublishedArtifactVersion {
  readonly artifact: ArtifactRecord
  readonly version: ArtifactVersionRecord
}

export interface GetArtifactInput {
  readonly projectId: string
  readonly id: string
}

export interface ListArtifactsInput {
  readonly projectId: string
  readonly owner?: Principal
  /** Only artifacts shared in this thread. */
  readonly threadId?: string
  /** Only artifacts of this kind. */
  readonly kind?: ArtifactKind
  readonly limit?: number
  readonly offset?: number
}

export interface ListArtifactsResult {
  readonly artifacts: readonly ArtifactRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface GetArtifactVersionInput {
  readonly projectId: string
  readonly artifactId: string
  readonly version: number
}

export interface ListArtifactVersionsInput {
  readonly projectId: string
  readonly artifactId: string
  readonly limit?: number
  readonly offset?: number
}

export interface ListArtifactVersionsResult {
  readonly versions: readonly ArtifactVersionRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface DeleteArtifactInput {
  readonly projectId: string
  readonly id: string
}

export interface CopyArtifactInput {
  readonly projectId: string
  /** The artifact copied. */
  readonly sourceId: string
  /** The copy's id. */
  readonly id: string
  /** Owns the copy. */
  readonly owner: Principal
  /** The thread the copy is shared in, as long as it lasts: a fork's. */
  readonly threadId: string
  readonly copiedAt?: Date
  /**
   * The outline a copied version takes instead of its own, when it returns one: what the copy's
   * new id changes in it, such as its canvas's render keys. Called with each version as the copy
   * holds it, in the copy's transaction.
   */
  readonly outlineOf?: (version: ArtifactVersionRecord) => ArtifactOutline | undefined
}

export interface ListReferencingVersionsInput {
  readonly projectId: string
  /** The artifact the versions refer to. */
  readonly artifactId: string
}

/**
 * A short-lived link to one version, which a sandboxed frame loads its files through: once the
 * files it serves change, the link serves nothing, so a frame never mixes two contents. Only the
 * SHA-256 of the link's token is stored; the token is the credential.
 */
export interface ArtifactFrameGrantRecord {
  readonly projectId: string
  /** SHA-256 hex of the token. */
  readonly tokenHash: string
  readonly artifactId: string
  readonly version: number
  /**
   * The files the frame serves, as a SHA-256 hex of their paths and digests: every file but a
   * canvas's `canvas.json`, so moving a canvas's items keeps its boards' links.
   */
  readonly filesDigest: string
  /** What the frame may show from other artifacts, decided for its reader when it was issued. */
  readonly targets: readonly ArtifactFrameTarget[]
  readonly createdAt: Date
  readonly expiresAt: Date
}

/**
 * An address a version embeds, and the version of its target a frame shows: the one the address
 * pins, a created version that never changes, or `latest`, whatever the target holds now.
 */
export interface ArtifactFrameTarget {
  readonly address: string
  readonly artifactId: string
  readonly version: number | "latest"
}

export interface FindArtifactFrameGrantInput {
  readonly projectId: string
  readonly tokenHash: string
}

export interface DeleteExpiredArtifactFrameGrantsInput {
  readonly projectId: string
  readonly expiredBefore: Date
  readonly limit: number
}

/** Whose values, kept by which artifact: a page keeps its own for each reader. */
export interface ArtifactStateScope {
  readonly projectId: string
  readonly artifactId: string
  readonly principal: Principal
}

export interface ArtifactStateKeyInput extends ArtifactStateScope {
  readonly key: string
}

export interface SetArtifactStateInput extends ArtifactStateKeyInput {
  /** JSON text, stored as written. */
  readonly value: string
  readonly updatedAt: Date
}

/** One value a page keeps for a reader. */
export interface ArtifactStateEntry {
  readonly key: string
  /** JSON text. */
  readonly value: string
  /** The value's UTF-8 bytes, which the reader's limits count. */
  readonly sizeBytes: number
  readonly updatedAt: Date
}

/**
 * A picture of a canvas's board in one mode and one size, kept under its render key: what the
 * board shows, in which artifact, as its version's outline names it. Versions that keep a board as
 * it was share its picture.
 */
export interface ArtifactBoardPreviewRecord {
  readonly projectId: string
  readonly renderKey: string
  readonly theme: ArtifactThemeMode
  readonly size: ArtifactBoardPreviewSize
  /** A PNG at full size, a WebP when small. */
  readonly file: FileRef
  readonly createdAt: Date
}

/**
 * `full`: the board at its own size, as it opens. `small`: at most 480 pixels wide, for a canvas
 * that shows many boards at once.
 */
export type ArtifactBoardPreviewSize = "full" | "small"

export interface ListArtifactBoardPreviewsInput {
  readonly projectId: string
  readonly renderKeys: readonly string[]
}

export interface PutArtifactBoardPreviewsInput {
  readonly projectId: string
  readonly previews: readonly Omit<ArtifactBoardPreviewRecord, "projectId">[]
}

/**
 * A designed document printed to PDF, kept under its render key: a hash of what it prints, which
 * its version names. Versions that print the same share it. When it could not be printed, why is
 * kept in its place, until it prints or someone asks for it again.
 */
export type ArtifactPdfRecord = ArtifactPdfKeyInput & { readonly createdAt: Date } & (
    | {
        readonly file: FileRef
        /** How many pages it printed on. */
        readonly pages: number
      }
    | {
        /** Why it could not be printed, as whoever asked for it hears it. */
        readonly failure: string
      }
  )

export interface ArtifactPdfKeyInput {
  readonly projectId: string
  readonly renderKey: string
}

/**
 * What a comment is about: a canvas's board, an element of it by its address, as
 * `boardElements` writes one, or the artifact itself, at the revision the author saw.
 */
export interface ArtifactCommentAnchor {
  readonly board?: string
  readonly element?: string
  /** The element's first words, which name it once it is gone. */
  readonly label?: string
  /**
   * Where on the board its pin is, as fractions of the board's width and height from its top left:
   * where its author clicked.
   */
  readonly point?: { readonly x: number; readonly y: number }
  readonly revision: number
}

/**
 * A visitor who opened a shared link to an object that holds the artifact: no account, only the
 * name they typed for their link's session. Comments are the one record a guest writes, so the
 * kind stays here rather than in `Principal`, which is who signed in.
 */
export interface ArtifactGuest {
  readonly type: "guest"
  /** The shared link's session they comment from: each session is one guest. */
  readonly id: string
  readonly name: string
}

/** Who wrote a comment: someone who signed in, the project's code, or a shared link's guest. */
export type ArtifactCommentAuthor = Principal | ArtifactGuest

/** A comment on an artifact, or a reply to one. */
export interface ArtifactCommentRecord {
  readonly projectId: string
  readonly artifactId: string
  readonly id: string
  /** The comment this one replies to: a reply takes no replies of its own. */
  readonly parentId?: string
  readonly anchor: ArtifactCommentAnchor
  /** Plain text. */
  readonly body: string
  readonly author: ArtifactCommentAuthor
  /** The Agent's run that wrote it for its author, and that run's conversation. */
  readonly origin?: ArtifactOrigin
  readonly createdAt: Date
  /** When someone marked it resolved, and who; a reply is resolved with what it replies to. */
  readonly resolvedAt?: Date
  readonly resolvedBy?: Principal
}

export type CreateArtifactCommentInput = Omit<ArtifactCommentRecord, "resolvedAt" | "resolvedBy">

export interface ArtifactCommentKey {
  readonly projectId: string
  readonly artifactId: string
  readonly id: string
}

export interface ResolveArtifactCommentInput extends ArtifactCommentKey {
  /** Resolved then, by them; null opens it again. */
  readonly resolved: { readonly at: Date; readonly by: Principal } | null
}

/**
 * Persistence only: who may read or publish, and what a version may contain, are decided in Core
 * before a call reaches storage.
 */
export interface ArtifactStorage {
  /**
   * Creates the artifact with its first version, open, shared in its origin's thread. Throws
   * `artifact_exists` when the id is taken.
   */
  create(input: CreateArtifactInput): Promise<PublishedArtifactVersion>
  /**
   * Writes the latest version's content: in place while it is open, or as the next version, open,
   * when it is frozen. Either way the revision grows, and the artifact is shared in its origin's
   * thread. A turn's first write keeps a restore point of the latest version first.
   *
   * Throws `artifact_not_found`, `artifact_kind_mismatch`, or `artifact_moved` with the latest
   * version, the revision and who last wrote it when `baseRevision` is not the artifact's,
   * checked in the same transaction as the write, so of two writes from one base only the first is
   * stored. A version number is never reused, even after its version is deleted.
   */
  publish(input: PublishArtifactVersionInput): Promise<PublishedArtifactVersion>
  /**
   * Freezes the open latest version, at a new revision: the next write opens the next version.
   * A frozen latest version is returned as it is, whatever `baseRevision` says. Throws
   * `artifact_not_found`, or `artifact_moved` when the open version changed past `baseRevision`.
   */
  freeze(input: FreezeArtifactVersionInput): Promise<PublishedArtifactVersion>
  /** Newest first: each artifact keeps its last `ARTIFACT_RESTORE_POINTS`. */
  listRestorePoints(input: GetArtifactInput): Promise<ArtifactRestorePointRecord[]>
  getRestorePoint(input: GetArtifactRestorePointInput): Promise<ArtifactRestorePointRecord | null>
  /**
   * Writes a restore point's content to the latest version, as `publish` writes, after
   * keeping a restore point of what it replaces, so the restore can be undone. Throws
   * `artifact_not_found`, `restore_point_not_found`, or `artifact_moved` past `baseRevision`.
   */
  restoreTo(input: RestoreArtifactInput): Promise<PublishedArtifactVersion>
  /** The artifacts a turn wrote, its sub-agents' writes among them, by artifact id. */
  listTurnWrites(input: ArtifactTurnInput): Promise<ArtifactTurnWriteRecord[]>
  /**
   * Undoes what a turn wrote, for a retry of it: an artifact only the turn changed since its
   * restore point, as `turnUndoable` says, is put back as that point holds it, and deleted
   * when the turn created it; one anyone else changed, before, between, or after the turn's writes,
   * keeps the changes, its restore point, and the threads it is shared in, and so does one whose
   * version someone created. An artifact put back is no longer shared in the threads the turn alone
   * shared it in, unless it was copied for them. The turn's writes are forgotten.
   */
  undoTurnWrites(input: UndoArtifactTurnInput): Promise<UndoneArtifactTurn>
  get(input: GetArtifactInput): Promise<ArtifactRecord | null>
  /** Most recently updated first. */
  list(input: ListArtifactsInput): Promise<ListArtifactsResult>
  getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null>
  /** Newest first. */
  listVersions(input: ListArtifactVersionsInput): Promise<ListArtifactVersionsResult>
  /**
   * The threads the artifact is shared in, by id: each one it was written from, and the one it was
   * copied for.
   */
  listThreadIds(input: GetArtifactInput): Promise<string[]>
  /**
   * Copies an artifact with every version under its number, frozen or open as it is, each without
   * its origin, as a new artifact shared in `threadId` for as long as it lasts: a fork's copy,
   * whose `@N` addresses still resolve. Its restore points stay with the source. The files are
   * reused, not copied. Throws `artifact_not_found` without the source and `artifact_exists` when
   * the id is taken.
   */
  copy(input: CopyArtifactInput): Promise<ArtifactRecord>
  /**
   * The latest version of each artifact whose latest version has an address to this artifact, so
   * a new version can tell which artifacts it breaks. Ordered by artifact id.
   */
  listReferencingVersions(input: ListReferencingVersionsInput): Promise<ArtifactVersionRecord[]>
  /** Stores a frame grant. Throws `artifact_not_found` when its artifact does not exist. */
  createFrameGrant(record: ArtifactFrameGrantRecord): Promise<void>
  /** Returns expired grants too; the caller decides whether one still serves. */
  findFrameGrant(input: FindArtifactFrameGrantInput): Promise<ArtifactFrameGrantRecord | null>
  /** Deletes up to `limit` grants that expired before `expiredBefore`, and returns the count. */
  deleteExpiredFrameGrants(input: DeleteExpiredArtifactFrameGrantsInput): Promise<number>
  /** A value a page keeps for a reader, or null when it keeps none under the key. */
  getState(input: ArtifactStateKeyInput): Promise<ArtifactStateEntry | null>
  /**
   * Keeps a value under its key, replacing one there. Throws `artifact_not_found`, or
   * `artifact_state_full` when the value, or the reader's keys or bytes with it, would pass
   * `ARTIFACT_STATE_LIMITS`, checked in the same transaction as the write.
   */
  setState(input: SetArtifactStateInput): Promise<void>
  /** `false` when there was no value under the key. */
  deleteState(input: ArtifactStateKeyInput): Promise<boolean>
  /** Every value a page keeps for a reader, by key. */
  listState(input: ArtifactStateScope): Promise<ArtifactStateEntry[]>
  /** Deletes every value a page keeps for a reader, and returns how many. */
  clearState(input: ArtifactStateScope): Promise<number>
  /** The pictures kept under these render keys, in every mode and size, by key, mode, then size. */
  listBoardPreviews(input: ListArtifactBoardPreviewsInput): Promise<ArtifactBoardPreviewRecord[]>
  /**
   * Keeps each picture under its render key, mode, and size. One already kept there stays: the key names
   * what the board shows, so both are pictures of the same page. Deleting an artifact keeps them.
   */
  putBoardPreviews(input: PutArtifactBoardPreviewsInput): Promise<void>
  /** The PDF kept under a render key, or why it could not be printed; null when neither is. */
  getPdf(input: ArtifactPdfKeyInput): Promise<ArtifactPdfRecord | null>
  /**
   * Keeps a PDF, or why it could not be printed, under its render key. A PDF replaces a failure;
   * anything else already kept there stays: the key names what it prints. Deleting an artifact
   * keeps them.
   */
  putPdf(input: ArtifactPdfRecord): Promise<void>
  /** Forgets why the PDF under a render key could not be printed. A PDF kept there stays. */
  clearPdfFailure(input: ArtifactPdfKeyInput): Promise<void>
  /**
   * Adds a comment, or a reply to one. Throws `artifact_not_found`; `comment_not_found` when
   * `parentId` names no comment of the artifact, or a reply; and `artifact_comments_full` past
   * `ARTIFACT_COMMENT_LIMITS.maxComments`, or, for a guest's, past `maxGuestComments` written by
   * guests, both checked in the same transaction as the write.
   */
  createComment(input: CreateArtifactCommentInput): Promise<ArtifactCommentRecord>
  getComment(input: ArtifactCommentKey): Promise<ArtifactCommentRecord | null>
  /** Every comment and reply of the artifact, oldest first. */
  listComments(input: GetArtifactInput): Promise<ArtifactCommentRecord[]>
  /** Marks a comment resolved, or opens it again. Null when there is no such comment. */
  resolveComment(input: ResolveArtifactCommentInput): Promise<ArtifactCommentRecord | null>
  /** Deletes a comment and its replies. `false` when there is no such comment. */
  deleteComment(input: ArtifactCommentKey): Promise<boolean>
  /**
   * Deletes the artifact, every version, its restore points, its comments, its frame grants, and
   * what it keeps for its readers. `false` when it does not exist.
   */
  delete(input: DeleteArtifactInput): Promise<boolean>
}
