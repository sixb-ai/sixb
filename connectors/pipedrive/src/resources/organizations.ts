import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedriveOrganization,
  PipedriveOrganizationGetOptions,
  PipedriveOrganizationInput,
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
  /** `POST /organizations` */
  create(input: PipedriveOrganizationInput): Promise<PipedriveResponse<PipedriveOrganization>>
  /** `GET /organizations/{id}` */
  get(
    id: number,
    options?: PipedriveOrganizationGetOptions
  ): Promise<PipedriveResponse<PipedriveOrganization>>
  /** `PATCH /organizations/{id}` */
  update(
    id: number,
    input: Partial<PipedriveOrganizationInput>
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
    create(input) {
      return http.post("v2", "organizations", input)
    },
    get(id, options) {
      return http.get("v2", `organizations/${pathPart(id, "organization id")}`, options)
    },
    update(id, input) {
      return http.patch("v2", `organizations/${pathPart(id, "organization id")}`, input)
    },
    search(options) {
      return http.get("v2", "organizations/search", options)
    },
  }

  return resource
}
