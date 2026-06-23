import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderDeal,
  TeamleaderDealListItem,
  TeamleaderListResponse,
  TeamleaderSingleResponse,
} from "../types"

export function createDealsResource(request: TeamleaderRequester): TeamleaderClient["deals"] {
  const resource: TeamleaderClient["deals"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderDealListItem>>(
        "/deals.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
    info(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderDeal>>("/deals.info", body, requestOptions)
    },
  }

  return resource
}
