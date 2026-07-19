/**
 * Hand-written types for the Drive v3 endpoints this connector uses. They cover
 * the common fields plus an open index signature, because Drive's `fields`
 * param returns partial resources — we surface whatever Google returns rather
 * than pretending to model the whole schema.
 *
 * `*Options` types intersect `QueryParams` so they pass straight to the HTTP
 * layer as query strings without casts (the pipedrive idiom).
 */
import type { QueryParams } from "./common"

export interface DriveUser {
  readonly displayName?: string
  readonly emailAddress?: string
  readonly kind?: string
  readonly [key: string]: unknown
}

export interface DriveFile {
  readonly id: string
  readonly name?: string
  readonly mimeType?: string
  readonly createdTime?: string
  readonly modifiedTime?: string
  readonly parents?: readonly string[]
  readonly owners?: readonly DriveUser[]
  readonly webViewLink?: string
  readonly size?: string
  readonly trashed?: boolean
  readonly [key: string]: unknown
}

export type DriveFilesListOptions = QueryParams & {
  /** Drive query string, e.g. `"'FOLDER_ID' in parents and trashed = false"`. */
  readonly q?: string
  /** Partial-response selector, e.g. `"nextPageToken, files(id, name, modifiedTime)"`. */
  readonly fields?: string
  readonly pageSize?: number
  readonly pageToken?: string
  readonly orderBy?: string
  readonly spaces?: string
  readonly corpora?: string
  readonly driveId?: string
  readonly includeItemsFromAllDrives?: boolean
  readonly supportsAllDrives?: boolean
}

export interface DriveFileList {
  readonly files?: readonly DriveFile[]
  readonly nextPageToken?: string
  readonly incompleteSearch?: boolean
}

export type DriveFileGetOptions = QueryParams & {
  readonly fields?: string
  readonly supportsAllDrives?: boolean
  readonly acknowledgeAbuse?: boolean
}

export interface DriveChange {
  readonly fileId?: string
  readonly file?: DriveFile
  readonly removed?: boolean
  readonly time?: string
  readonly changeType?: string
  readonly [key: string]: unknown
}

export type DriveChangesListOptions = QueryParams & {
  /** Required. Obtain the first token from `changes.getStartPageToken`. */
  readonly pageToken: string
  readonly fields?: string
  readonly pageSize?: number
  readonly spaces?: string
  readonly driveId?: string
  readonly includeRemoved?: boolean
  readonly includeItemsFromAllDrives?: boolean
  readonly supportsAllDrives?: boolean
}

export interface DriveChangeList {
  readonly changes?: readonly DriveChange[]
  readonly nextPageToken?: string
  /** Present on the final page — persist it as the checkpoint for the next poll. */
  readonly newStartPageToken?: string
}

export interface DriveStartPageToken {
  readonly startPageToken: string
}

export type DriveStartPageTokenOptions = QueryParams & {
  readonly driveId?: string
  readonly supportsAllDrives?: boolean
}

/* ------------------------------------------------------------------------ */
/* Write path                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Bodies the Drive upload paths accept. Streams and Blobs upload with memory
 * bounded to roughly one chunk — the whole payload is never read into memory.
 */
export type DriveUploadBody = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>

/**
 * Media bytes for `files.create` / `files.update`.
 *
 * `mimeType` is the content type of the bytes (defaults to
 * `application/octet-stream`); the file's stored Drive type comes from the
 * metadata `mimeType` when set. `sizeBytes` is a hint for **streams only**
 * (buffered bodies always use their real length): it lets a stream take the
 * chunked resumable path — pass `BlobStorage.stat(...).sizeBytes` when piping
 * blobs. It must be exact; a wrong count fails the upload.
 */
export interface DriveFileContent {
  readonly body: DriveUploadBody
  readonly mimeType?: string
  readonly sizeBytes?: number
}

/**
 * File metadata sent as the JSON request body. Open-ended like `DriveFile`:
 * unknown keys pass straight through to the API — which also means a mistyped
 * key (or a query param the write input doesn't whitelist) is sent as metadata
 * and ignored by Drive without an error.
 */
export interface DriveFileMetadataInput {
  readonly name?: string
  readonly mimeType?: string
  readonly description?: string
  /** Create-only: parent folder ids. Moves on update use `addParents`/`removeParents`. */
  readonly parents?: readonly string[]
  readonly starred?: boolean
  /** Update-only: `true` trashes the file, `false` restores it. */
  readonly trashed?: boolean
  readonly [key: string]: unknown
}

/**
 * `files.create` input. Top-level keys are metadata (the JSON body) except the
 * known query params below and `content`, which selects the media bytes.
 */
export type DriveFileCreateInput = DriveFileMetadataInput & {
  readonly name: string
  readonly content?: DriveFileContent
  readonly fields?: string
  readonly supportsAllDrives?: boolean
  readonly keepRevisionForever?: boolean
  readonly enforceSingleParent?: boolean
}

/** `files.update` input — metadata patch, content replacement, or both. */
export type DriveFileUpdateInput = DriveFileMetadataInput & {
  readonly content?: DriveFileContent
  /** Comma-separated parent ids to add (move between folders). */
  readonly addParents?: string
  /** Comma-separated parent ids to remove. */
  readonly removeParents?: string
  readonly fields?: string
  readonly supportsAllDrives?: boolean
  readonly keepRevisionForever?: boolean
}

export type DriveFileCopyInput = DriveFileMetadataInput & {
  readonly fields?: string
  readonly supportsAllDrives?: boolean
}

export type DriveFileDeleteOptions = QueryParams & {
  readonly supportsAllDrives?: boolean
  readonly enforceSingleParent?: boolean
}
