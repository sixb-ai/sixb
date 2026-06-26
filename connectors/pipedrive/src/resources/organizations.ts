import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedriveOrganization,
  PipedriveOrganizationGetOptions,
  PipedriveOrganizationListOptions,
  PipedriveOrganizationSearchOptions,
  PipedriveResponse,
  PipedriveSearchResponse,
} from "../types"

export interface OrganizationsResource {
  /** `GET /organizations` */
  list(
    options?: PipedriveOrganizationListOptions
  ): Promise<PipedriveCursorPage<PipedriveOrganization>>
  listAll(options?: PipedriveOrganizationListOptions): AsyncIterable<PipedriveOrganization>
  /** `GET /organizations/{id}` */
  get(
    id: number,
    options?: PipedriveOrganizationGetOptions
  ): Promise<PipedriveResponse<PipedriveOrganization>>
  /** `GET /organizations/search` */
  search(options: PipedriveOrganizationSearchOptions): Promise<PipedriveSearchResponse>
}

export function organizationsResource(http: PipedriveHttp): OrganizationsResource {
  const resource: OrganizationsResource = {
    list(options) {
      return http.get("v2", "organizations", options)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id, options) {
      return http.get("v2", `organizations/${pathPart(id, "organization id")}`, options)
    },
    search(options) {
      return http.get("v2", "organizations/search", options)
    },
  }

  return resource
}
