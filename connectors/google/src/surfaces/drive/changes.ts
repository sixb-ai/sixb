import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  DriveChange,
  DriveChangeList,
  DriveChangesListOptions,
  DriveStartPageToken,
  DriveStartPageTokenOptions,
} from "../../types/drive"

export interface DriveChangesResource {
  /** `GET /changes/startPageToken` — the checkpoint to start a future change feed from. */
  getStartPageToken(options?: DriveStartPageTokenOptions): Promise<DriveStartPageToken>
  /** `GET /changes` — one page of the incremental change feed. */
  list(options: DriveChangesListOptions): Promise<DriveChangeList>
  /**
   * Iterate every change from `options.pageToken` to the end of the current
   * feed. Read `newStartPageToken` from a fresh `list` call (or the last page)
   * to persist the next checkpoint — `listAll` intentionally does not expose it.
   */
  listAll(options: DriveChangesListOptions): AsyncIterable<DriveChange>
}

export function driveChangesResource(http: GoogleHttp): DriveChangesResource {
  const resource: DriveChangesResource = {
    getStartPageToken(options) {
      return http.json<DriveStartPageToken>("drive", "GET", "changes/startPageToken", {
        query: options,
      })
    },
    list(options) {
      return http.json<DriveChangeList>("drive", "GET", "changes", { query: options })
    },
    listAll(options) {
      return listAllPages<DriveChangeList, DriveChange>(
        (pageToken) => resource.list({ ...options, pageToken: pageToken ?? options.pageToken }),
        (page) => page.changes,
        options.pageToken
      )
    },
  }

  return resource
}
