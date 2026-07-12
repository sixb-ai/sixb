import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderDeal,
  TeamleaderDealListItem,
  TeamleaderListResponse,
  TeamleaderSingleResponse,
  TeamleaderTypeAndId,
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
    create(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderTypeAndId<"deal">>>(
        "/deals.create",
        body,
        requestOptions
      )
    },
    update(body, requestOptions) {
      return request<void>("/deals.update", body, requestOptions)
    },
    move(body, requestOptions) {
      return request<void>("/deals.move", body, requestOptions)
    },
    win(body, requestOptions) {
      return request<void>("/deals.win", body, requestOptions)
    },
    lose(body, requestOptions) {
      return request<void>("/deals.lose", body, requestOptions)
    },
    delete(body, requestOptions) {
      return request<void>("/deals.delete", body, requestOptions)
    },
  }

  return resource
}
