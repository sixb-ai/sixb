import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedrivePipeline,
  PipedrivePipelineListOptions,
  PipedriveResponse,
} from "../types"

export interface PipelinesResource {
  /** `GET /pipelines` */
  list(options?: PipedrivePipelineListOptions): Promise<PipedriveCursorPage<PipedrivePipeline>>
  listAll(options?: PipedrivePipelineListOptions): AsyncIterable<PipedrivePipeline>
  /** `GET /pipelines/{id}` */
  get(id: number): Promise<PipedriveResponse<PipedrivePipeline>>
}

export function pipelinesResource(http: PipedriveHttp): PipelinesResource {
  const resource: PipelinesResource = {
    list(options) {
      return http.get("v2", "pipelines", options)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id) {
      return http.get("v2", `pipelines/${pathPart(id, "pipeline id")}`)
    },
  }

  return resource
}
