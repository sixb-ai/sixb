import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedriveProduct,
  PipedriveProductGetOptions,
  PipedriveProductListOptions,
  PipedriveProductSearchOptions,
  PipedriveResponse,
  PipedriveSearchResponse,
} from "../types"

export interface ProductsResource {
  /** `GET /products` */
  list(options?: PipedriveProductListOptions): Promise<PipedriveCursorPage<PipedriveProduct>>
  listAll(options?: PipedriveProductListOptions): AsyncIterable<PipedriveProduct>
  /** `GET /products/{id}` */
  get(
    id: number,
    options?: PipedriveProductGetOptions
  ): Promise<PipedriveResponse<PipedriveProduct>>
  /** `GET /products/search` */
  search(options: PipedriveProductSearchOptions): Promise<PipedriveSearchResponse>
}

export function productsResource(http: PipedriveHttp): ProductsResource {
  const resource: ProductsResource = {
    list(options) {
      return http.get("v2", "products", options)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id, options) {
      return http.get("v2", `products/${pathPart(id, "product id")}`, options)
    },
    search(options) {
      return http.get("v2", "products/search", options)
    },
  }

  return resource
}
