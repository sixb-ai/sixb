import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveActivity,
  PipedriveActivityListOptions,
  PipedriveCursorPage,
  PipedriveResponse,
} from "../types"

export interface ActivitiesResource {
  /** `GET /activities` */
  list(options?: PipedriveActivityListOptions): Promise<PipedriveCursorPage<PipedriveActivity>>
  listAll(options?: PipedriveActivityListOptions): AsyncIterable<PipedriveActivity>
  /** `GET /activities/{id}` */
  get(id: number): Promise<PipedriveResponse<PipedriveActivity>>
}

export function activitiesResource(http: PipedriveHttp): ActivitiesResource {
  const resource: ActivitiesResource = {
    list(options) {
      return http.get("v2", "activities", options)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id) {
      return http.get("v2", `activities/${pathPart(id, "activity id")}`)
    },
  }

  return resource
}
