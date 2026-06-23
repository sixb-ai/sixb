import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderListResponse,
  TeamleaderQuotation,
  TeamleaderQuotationListItem,
  TeamleaderSingleResponse,
} from "../types"

export function createQuotationsResource(
  request: TeamleaderRequester
): TeamleaderClient["quotations"] {
  const resource: TeamleaderClient["quotations"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderQuotationListItem>>(
        "/quotations.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
    info(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderQuotation>>(
        "/quotations.info",
        body,
        requestOptions
      )
    },
  }

  return resource
}
