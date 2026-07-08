import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderListResponse,
  TeamleaderProduct,
  TeamleaderProductListItem,
  TeamleaderSingleResponse,
} from "../types"

export function createProductsResource(request: TeamleaderRequester): TeamleaderClient["products"] {
  const resource: TeamleaderClient["products"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderProductListItem>>(
        "/products.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
    info(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderProduct>>(
        "/products.info",
        body,
        requestOptions
      )
    },
  }

  return resource
}
