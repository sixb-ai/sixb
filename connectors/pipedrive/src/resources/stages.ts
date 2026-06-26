import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedriveResponse,
  PipedriveStage,
  PipedriveStageListOptions,
} from "../types"

export interface StagesResource {
  /** `GET /stages` */
  list(options?: PipedriveStageListOptions): Promise<PipedriveCursorPage<PipedriveStage>>
  listAll(options?: PipedriveStageListOptions): AsyncIterable<PipedriveStage>
  /** `GET /stages/{id}` */
  get(id: number): Promise<PipedriveResponse<PipedriveStage>>
}

export function stagesResource(http: PipedriveHttp): StagesResource {
  const resource: StagesResource = {
    list(options) {
      return http.get("v2", "stages", options)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id) {
      return http.get("v2", `stages/${pathPart(id, "stage id")}`)
    },
  }

  return resource
}
