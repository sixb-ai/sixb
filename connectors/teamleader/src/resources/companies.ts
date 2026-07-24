import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderCompany,
  TeamleaderCompanyListItem,
  TeamleaderListResponse,
  TeamleaderSingleResponse,
  TeamleaderTypeAndId,
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
    add(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderTypeAndId<"company">>>(
        "/companies.add",
        body,
        requestOptions
      )
    },
    update(body, requestOptions) {
      return request<void>("/companies.update", body, requestOptions)
    },
    delete(body, requestOptions) {
      return request<void>("/companies.delete", body, requestOptions)
    },
    tag(body, requestOptions) {
      return request<void>("/companies.tag", body, requestOptions)
    },
    untag(body, requestOptions) {
      return request<void>("/companies.untag", body, requestOptions)
    },
    uploadLogo(body, requestOptions) {
      return request<void>("/companies.uploadLogo", body, requestOptions)
    },
  }

  return resource
}
