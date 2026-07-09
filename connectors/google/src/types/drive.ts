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
