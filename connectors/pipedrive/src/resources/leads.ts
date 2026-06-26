import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllOffset } from "../pagination"
import type {
  PipedriveJsonObject,
  PipedriveLead,
  PipedriveLeadListOptions,
  PipedriveLeadSearchOptions,
  PipedriveOffsetPage,
  PipedriveResponse,
  PipedriveSearchResponse,
} from "../types"

export interface LeadsResource {
  /** `GET /leads` */
  list(options?: PipedriveLeadListOptions): Promise<PipedriveOffsetPage<PipedriveLead>>
  listAll(options?: PipedriveLeadListOptions): AsyncIterable<PipedriveLead>
  /** `GET /leads/archived` */
  listArchived(options?: PipedriveLeadListOptions): Promise<PipedriveOffsetPage<PipedriveLead>>
  listAllArchived(options?: PipedriveLeadListOptions): AsyncIterable<PipedriveLead>
  /** `GET /leads/{id}` */
  get(id: string): Promise<PipedriveResponse<PipedriveLead>>
  /** `GET /leads/search` */
  search(options: PipedriveLeadSearchOptions): Promise<PipedriveSearchResponse>
  /** `GET /leads/{id}/permittedUsers` */
  permittedUsers(id: string): Promise<PipedriveResponse<readonly PipedriveJsonObject[]>>
}

export function leadsResource(http: PipedriveHttp): LeadsResource {
  const resource: LeadsResource = {
    list(options) {
      return http.get("v1", "leads", options)
    },
    listAll(options) {
      return listAllOffset(resource.list, options)
    },
    listArchived(options) {
      return http.get("v1", "leads/archived", options)
    },
    listAllArchived(options) {
      return listAllOffset(resource.listArchived, options)
    },
    get(id) {
      return http.get("v1", `leads/${pathPart(id, "lead id")}`)
    },
    search(options) {
      return http.get("v1", "leads/search", options)
    },
    permittedUsers(id) {
      return http.get("v1", `leads/${pathPart(id, "lead id")}/permittedUsers`)
    },
  }

  return resource
}
