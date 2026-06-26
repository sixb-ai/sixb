import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllOffset } from "../pagination"
import type {
  PipedriveFile,
  PipedriveFileListOptions,
  PipedriveOffsetPage,
  PipedriveResponse,
} from "../types"

export interface FilesResource {
  /** `GET /files` */
  list(options?: PipedriveFileListOptions): Promise<PipedriveOffsetPage<PipedriveFile>>
  listAll(options?: PipedriveFileListOptions): AsyncIterable<PipedriveFile>
  /** `GET /files/{id}` */
  get(id: number): Promise<PipedriveResponse<PipedriveFile>>
}

export function filesResource(http: PipedriveHttp): FilesResource {
  const resource: FilesResource = {
    list(options) {
      return http.get("v1", "files", options)
    },
    listAll(options) {
      return listAllOffset(resource.list, options)
    },
    get(id) {
      return http.get("v1", `files/${pathPart(id, "file id")}`)
    },
  }

  return resource
}
