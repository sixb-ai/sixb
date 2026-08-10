import type { UnipileHttp } from "../http"
import { listAllCursor } from "../pagination"
import type { UnipileAccount, UnipileAccountListOptions, UnipileAccountsResponse } from "../types"
import { assertLimit, pathId } from "../validation"

export interface AccountsResource {
  /** `GET /accounts` */
  list(options?: UnipileAccountListOptions): Promise<UnipileAccountsResponse>
  /** Cursor iterator over `GET /accounts`. */
  listAll(options?: UnipileAccountListOptions): AsyncIterable<UnipileAccount>
  /** `GET /accounts/{accountId}` */
  get(accountId: string): Promise<UnipileAccount>
}

export function createAccountsResource(http: UnipileHttp): AccountsResource {
  const resource: AccountsResource = {
    list(options) {
      assertLimit(options?.limit)
      return http.get("accounts", { limit: options?.limit, cursor: options?.cursor }, true)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(accountId) {
      return http.get(`accounts/${pathId(accountId, "account id")}`, undefined, true)
    },
  }

  return resource
}
