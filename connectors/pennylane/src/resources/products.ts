import type { PennylaneHttp } from "../http"
import { listAllCursor } from "../pagination"
import { buildListQuery } from "../query"
import type {
  PennylaneCreateProductInput,
  PennylaneCursorPage,
  PennylaneProduct,
  PennylaneProductListOptions,
  PennylaneUpdateProductInput,
} from "../types"
import { assertCursorOptions, pathId } from "../validation"

export interface ProductsResource {
  /** `GET /products` */
  list(options?: PennylaneProductListOptions): Promise<PennylaneCursorPage<PennylaneProduct>>
  listAll(options?: PennylaneProductListOptions): AsyncIterable<PennylaneProduct>
  /** `GET /products/{id}` */
  get(id: number): Promise<PennylaneProduct>
  /** `POST /products` */
  create(input: PennylaneCreateProductInput): Promise<PennylaneProduct>
  /** `PUT /products/{id}` */
  update(id: number, input: PennylaneUpdateProductInput): Promise<PennylaneProduct>
}

export function createProductsResource(http: PennylaneHttp): ProductsResource {
  const resource: ProductsResource = {
    list(options) {
      assertCursorOptions(options, 100)
      return http.get("products", buildListQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id) {
      return http.get(`products/${pathId(id, "product id")}`)
    },
    create(input) {
      return http.post("products", input)
    },
    update(id, input) {
      return http.put(`products/${pathId(id, "product id")}`, input)
    },
  }

  return resource
}
