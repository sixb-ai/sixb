import type { MercuryHttp } from "../http"
import { listAllCursor } from "../pagination"
import { cursorQuery } from "../query"
import type {
  MercuryMerchant,
  MercuryMerchantListOptions,
  MercuryMerchantsResponse,
} from "../types"
import { assertCursorOptions } from "../validation"

export interface MerchantsResource {
  /** `GET /merchants` */
  list(options?: MercuryMerchantListOptions): Promise<MercuryMerchantsResponse>
  /** Cursor iterator over `GET /merchants`. */
  listAll(options?: MercuryMerchantListOptions): AsyncIterable<MercuryMerchant>
}

export function createMerchantsResource(http: MercuryHttp): MerchantsResource {
  const resource: MerchantsResource = {
    list(options) {
      assertCursorOptions(options)
      return http.get("merchants", { ...cursorQuery(options), search: options?.search })
    },
    listAll(options) {
      return listAllCursor(resource.list, (page) => page.data, options)
    },
  }

  return resource
}
