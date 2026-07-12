import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderListResponse,
  TeamleaderProduct,
  TeamleaderProductListItem,
  TeamleaderSingleResponse,
  TeamleaderTypeAndId,
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
    add(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderTypeAndId<"product">>>(
        "/products.add",
        body,
        requestOptions
      )
    },
    update(body, requestOptions) {
      return request<void>("/products.update", body, requestOptions)
    },
    delete(body, requestOptions) {
      return request<void>("/products.delete", body, requestOptions)
    },
  }

  return resource
}
