import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderCompany,
  TeamleaderCompanyListItem,
  TeamleaderListResponse,
  TeamleaderSingleResponse,
} from "../types"

export function createCompaniesResource(
  request: TeamleaderRequester
): TeamleaderClient["companies"] {
  const resource: TeamleaderClient["companies"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderCompanyListItem>>(
        "/companies.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
    info(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderCompany>>(
        "/companies.info",
        body,
        requestOptions
      )
    },
  }

  return resource
}
