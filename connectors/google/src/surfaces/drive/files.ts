import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  DriveFile,
  DriveFileGetOptions,
  DriveFileList,
  DriveFilesListOptions,
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
  }

  return resource
}
