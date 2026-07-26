import type { MercuryHttp } from "../http"
import { listAllCursor } from "../pagination"
import { cursorQuery } from "../query"
import type {
  MercuryCategoriesResponse,
  MercuryCategory,
  MercuryCategoryListOptions,
  MercuryCreateCategoryInput,
  MercuryUpdateCategoryInput,
} from "../types"
import { assertCursorOptions, pathId } from "../validation"

/**
 * The organization's custom expense categories. Mercury's fixed merchant-type vocabulary
 * (`mercuryCategory` on a transaction) is not managed here — it is read-only.
 */
export interface CategoriesResource {
  /** `GET /categories` */
  list(options?: MercuryCategoryListOptions): Promise<MercuryCategoriesResponse>
  /** Cursor iterator over `GET /categories`. */
  listAll(options?: MercuryCategoryListOptions): AsyncIterable<MercuryCategory>
  /** `POST /categories` */
  create(input: MercuryCreateCategoryInput): Promise<MercuryCategory>
  /** `POST /categories/{categoryId}` — Mercury uses POST, not PUT or PATCH, to edit. */
  update(categoryId: string, input: MercuryUpdateCategoryInput): Promise<MercuryCategory>
  /** `DELETE /categories/{categoryId}` */
  delete(categoryId: string): Promise<void>
}

export function createCategoriesResource(http: MercuryHttp): CategoriesResource {
  const resource: CategoriesResource = {
    list(options) {
      assertCursorOptions(options)
      return http.get("categories", cursorQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, (page) => page.categories, options)
    },
    create(input) {
      return http.post("categories", input)
    },
    update(categoryId, input) {
      return http.post(`categories/${pathId(categoryId, "category id")}`, input)
    },
    delete(categoryId) {
      return http.delete(`categories/${pathId(categoryId, "category id")}`)
    },
  }

  return resource
}
