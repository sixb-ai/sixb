import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocCatalogItem,
  PandaDocCatalogItemInput,
  PandaDocCatalogItemSearchOptions,
  PandaDocItemsResponse,
} from "../types"

export interface ProductCatalogResource {
  /** `GET /public/v2/product-catalog/items/search` */
  searchItems(
    options?: PandaDocCatalogItemSearchOptions
  ): Promise<PandaDocItemsResponse<PandaDocCatalogItem>>
  /** `POST /public/v2/product-catalog/items` */
  createItem(input: PandaDocCatalogItemInput): Promise<PandaDocCatalogItem>
  /** `GET /public/v2/product-catalog/items/{item_uuid}` */
  getItem(itemUuid: string): Promise<PandaDocCatalogItem>
  /** `PATCH /public/v2/product-catalog/items/{item_uuid}` */
  updateItem(
    itemUuid: string,
    input: Partial<PandaDocCatalogItemInput>
  ): Promise<PandaDocCatalogItem>
  /** `DELETE /public/v2/product-catalog/items/{item_uuid}` */
  deleteItem(itemUuid: string): Promise<void>
}

export function productCatalogResource(http: PandaDocHttp): ProductCatalogResource {
  return {
    searchItems(options) {
      return http.get("public/v2/product-catalog/items/search", options)
    },
    createItem(input) {
      return http.post("public/v2/product-catalog/items", input)
    },
    getItem(itemUuid) {
      return http.get(`public/v2/product-catalog/items/${pathPart(itemUuid, "catalog item uuid")}`)
    },
    updateItem(itemUuid, input) {
      return http.patch(
        `public/v2/product-catalog/items/${pathPart(itemUuid, "catalog item uuid")}`,
        input
      )
    },
    deleteItem(itemUuid) {
      return http.delete(
        `public/v2/product-catalog/items/${pathPart(itemUuid, "catalog item uuid")}`
      )
    },
  }
}
