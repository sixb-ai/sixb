import type { ArtifactKind } from "../../artifacts/kinds"
import type { ArtifactOutline } from "../../artifacts/outline"
import type { ArtifactReference } from "../../artifacts/references"
import type { Principal } from "../../auth"
import type { FileRef } from "../../blob-storage"

export type { ArtifactKind, ArtifactOutline, ArtifactReference }

/** A versioned document, sheet, deck, page, or file. Its kind never changes. */
export interface ArtifactRecord {
  readonly projectId: string
  readonly id: string
  readonly kind: ArtifactKind
  /** The latest version's title. */
  readonly title: string
  /** Who created the artifact; reading and publishing are decided from it. */
  readonly owner: Principal
  readonly latestVersion: number
  readonly createdAt: Date
  /** When the latest version was published. */
  readonly updatedAt: Date
}

/** One file of a version, at its path inside the artifact. */
export interface ArtifactFile {
  /** Relative, with `/` separators and no `.` or `..` segments. */
  readonly path: string
  readonly file: FileRef
}

/** Where a version was published from. Provenance only: reading never depends on it. */
export interface ArtifactOrigin {
  readonly threadId: string
  readonly runId: string
}

/** One published version. A version never changes once stored. */
export interface ArtifactVersionRecord {
  readonly projectId: string
  readonly artifactId: string
  readonly version: number
  readonly title: string
  /** The path of the file the kind renders from, one of `files`. */
  readonly entry: string
  readonly files: readonly ArtifactFile[]
  readonly outline: ArtifactOutline
  readonly references: readonly ArtifactReference[]
  /** Who published this version. */
  readonly author: Principal
  readonly origin?: ArtifactOrigin
  readonly createdAt: Date
}

/** A version's content before storage numbers it. */
export type ArtifactVersionInput = Omit<
  ArtifactVersionRecord,
  "projectId" | "artifactId" | "version"
>

export interface CreateArtifactInput {
  readonly projectId: string
  readonly id: string
  readonly kind: ArtifactKind
  readonly owner: Principal
  /** Becomes version 1. */
  readonly version: ArtifactVersionInput
}

export interface PublishArtifactVersionInput {
  readonly projectId: string
  readonly artifactId: string
  /** Must be the artifact's kind. */
  readonly kind: ArtifactKind
  readonly version: ArtifactVersionInput
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
  /** Only artifacts with a version published from this thread. */
  readonly originThreadId?: string
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

export interface ListReferencingVersionsInput {
  readonly projectId: string
  /** The artifact the versions refer to. */
  readonly artifactId: string
}

/**
 * A short-lived link to one version, which a sandboxed frame loads a deck's files through. Only
 * the SHA-256 of the link's token is stored; the token is the credential.
 */
export interface ArtifactFrameGrantRecord {
  readonly projectId: string
  /** SHA-256 hex of the token. */
  readonly tokenHash: string
  readonly artifactId: string
  readonly version: number
  /** What the frame may show from other artifacts, decided for its reader when it was issued. */
  readonly targets: readonly ArtifactFrameTarget[]
  readonly createdAt: Date
  readonly expiresAt: Date
}

/** An address a version embeds, and the version of its target a frame shows. */
export interface ArtifactFrameTarget {
  readonly address: string
  readonly artifactId: string
  readonly version: number
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

export interface DeleteArtifactVersionsByOriginInput {
  readonly projectId: string
  readonly runId: string
}

/**
 * Persistence only: who may read or publish, and what a version may contain, are decided in Core
 * before a call reaches storage.
 */
export interface ArtifactStorage {
  /** Creates the artifact with its first version. Throws `artifact_exists` when the id is taken. */
  create(input: CreateArtifactInput): Promise<PublishedArtifactVersion>
  /**
   * Stores the next version and makes it the latest. Throws `artifact_not_found` or
   * `artifact_kind_mismatch`. A version number is never reused, even after its version is deleted.
   */
  publish(input: PublishArtifactVersionInput): Promise<PublishedArtifactVersion>
  get(input: GetArtifactInput): Promise<ArtifactRecord | null>
  /** Most recently updated first. */
  list(input: ListArtifactsInput): Promise<ListArtifactsResult>
  getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null>
  /** Newest first. */
  listVersions(input: ListArtifactVersionsInput): Promise<ListArtifactVersionsResult>
  /**
   * The latest version of each artifact whose latest version has an address to this artifact, so
   * a new version can tell which artifacts it breaks.
   */
  listReferencingVersions(input: ListReferencingVersionsInput): Promise<ArtifactVersionRecord[]>
  /** Stores a frame grant. Throws `artifact_not_found` when its artifact does not exist. */
  createFrameGrant(record: ArtifactFrameGrantRecord): Promise<void>
  /** Returns expired grants too; the caller decides whether one still serves. */
  findFrameGrant(input: FindArtifactFrameGrantInput): Promise<ArtifactFrameGrantRecord | null>
  /** Deletes up to `limit` grants that expired before `expiredBefore`, and returns the count. */
  deleteExpiredFrameGrants(input: DeleteExpiredArtifactFrameGrantsInput): Promise<number>
  /** Deletes the artifact, every version, and its frame grants. `false` when it does not exist. */
  delete(input: DeleteArtifactInput): Promise<boolean>
  /**
   * Deletes the versions a run published and returns how many. An artifact left without versions
   * is deleted; one that lost its latest version points at its newest remaining one.
   */
  deleteVersionsByOrigin(input: DeleteArtifactVersionsByOriginInput): Promise<number>
}
