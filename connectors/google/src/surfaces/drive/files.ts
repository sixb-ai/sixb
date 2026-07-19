import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import { listAllPages } from "../../pagination"
import type { QueryParams } from "../../types/common"
import type {
  DriveFile,
  DriveFileContent,
  DriveFileCopyInput,
  DriveFileCreateInput,
  DriveFileDeleteOptions,
  DriveFileGetOptions,
  DriveFileList,
  DriveFilesListOptions,
  DriveFileUpdateInput,
} from "../../types/drive"

export interface DriveFilesResource {
  /** `GET /files` — requires `drive.readonly` or `drive.meet.readonly`. */
  list(options?: DriveFilesListOptions): Promise<DriveFileList>
  /** Iterate every file across all pages of `list`. */
  listAll(options?: DriveFilesListOptions): AsyncIterable<DriveFile>
  /** `GET /files/{fileId}` — metadata only. */
  get(fileId: string, options?: DriveFileGetOptions): Promise<DriveFile>
  /**
   * `GET /files/{fileId}/export` — export a Google-native doc (e.g. a Meet
   * transcript Doc) to `text/plain`, `text/markdown`, `application/pdf`, …
   * Returns the raw bytes; the caller decides what to do with them.
   */
  export(fileId: string, mimeType: string): Promise<Uint8Array>
  /**
   * `POST /files` — create a file. Metadata-only without `content` (this is
   * also how folders are created: `mimeType: "application/vnd.google-apps.folder"`).
   * With `content`, bytes upload as multipart (≤ 5 MiB) or a resumable session
   * (larger bodies and streams). Requires a write scope (`drive.file`/`drive`).
   */
  create(input: DriveFileCreateInput): Promise<DriveFile>
  /**
   * `PATCH /files/{fileId}` — patch metadata, replace content, or both.
   * Moves between folders via `addParents`/`removeParents`; trashes or
   * restores via `{ trashed: true | false }`.
   */
  update(fileId: string, input: DriveFileUpdateInput): Promise<DriveFile>
  /** `DELETE /files/{fileId}` — permanent; use `update({ trashed: true })` to trash. */
  delete(fileId: string, options?: DriveFileDeleteOptions): Promise<void>
  /** `POST /files/{fileId}/copy` — duplicate a file (Google-native files included). */
  copy(fileId: string, input?: DriveFileCopyInput): Promise<DriveFile>
}

export function driveFilesResource(http: GoogleHttp): DriveFilesResource {
  const resource: DriveFilesResource = {
    list(options) {
      return http.json<DriveFileList>("drive", "GET", "files", { query: options })
    },
    listAll(options) {
      return listAllPages<DriveFileList, DriveFile>(
        (pageToken) => resource.list({ ...options, pageToken }),
        (page) => page.files,
        options?.pageToken
      )
    },
    get(fileId, options) {
      return http.json<DriveFile>("drive", "GET", `files/${pathSegment(fileId, "fileId")}`, {
        query: options,
      })
    },
    export(fileId, mimeType) {
      if (!mimeType.trim()) {
        throw new Error("[SixbGoogle] export mimeType must not be empty.")
      }
      return http.media("drive", `files/${pathSegment(fileId, "fileId")}/export`, {
        query: { mimeType },
      })
    },
    create(input) {
      const { metadata, query, content } = splitWriteInput(input, CREATE_QUERY_KEYS)
      return http.upload<DriveFile>("drive", "POST", "files", { query, metadata, content })
    },
    update(fileId, input) {
      const { metadata, query, content } = splitWriteInput(input, UPDATE_QUERY_KEYS)
      return http.upload<DriveFile>("drive", "PATCH", `files/${pathSegment(fileId, "fileId")}`, {
        query,
        metadata,
        content,
      })
    },
    async delete(fileId, options) {
      await http.json("drive", "DELETE", `files/${pathSegment(fileId, "fileId")}`, {
        query: options,
      })
    },
    copy(fileId, input) {
      const { metadata, query } = splitWriteInput(input ?? {}, COPY_QUERY_KEYS)
      return http.json<DriveFile>("drive", "POST", `files/${pathSegment(fileId, "fileId")}/copy`, {
        query,
        body: metadata,
      })
    },
  }

  return resource
}

/**
 * Query params accepted by `files.create` — everything else is metadata.
 * Missing entries silently become metadata no-ops, so keep this aligned with
 * the Drive v3 reference.
 */
const CREATE_QUERY_KEYS = [
  "fields",
  "supportsAllDrives",
  "keepRevisionForever",
  "enforceSingleParent",
  "ignoreDefaultVisibility",
  "includeLabels",
  "includePermissionsForView",
  "ocrLanguage",
  "useContentAsIndexableText",
] as const

/** Query params accepted by `files.update`. */
const UPDATE_QUERY_KEYS = [
  "fields",
  "supportsAllDrives",
  "keepRevisionForever",
  "addParents",
  "removeParents",
  "includeLabels",
  "includePermissionsForView",
  "ocrLanguage",
  "useContentAsIndexableText",
] as const

/** Query params accepted by `files.copy`. */
const COPY_QUERY_KEYS = [
  "fields",
  "supportsAllDrives",
  "keepRevisionForever",
  "enforceSingleParent",
  "ignoreDefaultVisibility",
  "includeLabels",
  "includePermissionsForView",
  "ocrLanguage",
] as const

interface SplitWriteInput {
  readonly metadata?: Record<string, unknown>
  readonly query?: QueryParams
  readonly content?: DriveFileContent
}

/**
 * Split a flat write input into its three destinations: `content` selects the
 * media bytes, known query params go to the query string, and every other key
 * is file metadata for the JSON body.
 */
function splitWriteInput(
  input: Record<string, unknown>,
  queryKeys: readonly string[]
): SplitWriteInput {
  const { content, ...rest } = input
  const query: Record<string, string | number | boolean> = {}
  const metadata: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) {
      continue
    }
    if (queryKeys.includes(key)) {
      query[key] = value as string | number | boolean
    } else {
      metadata[key] = value
    }
  }

  return {
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    query: Object.keys(query).length > 0 ? query : undefined,
    content: content as DriveFileContent | undefined,
  }
}
