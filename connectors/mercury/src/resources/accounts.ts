import type { MercuryHttp } from "../http"
import { listAllCursor } from "../pagination"
import { cursorQuery } from "../query"
import type { MercuryAccount, MercuryAccountListOptions, MercuryAccountsResponse } from "../types"
import { assertCursorOptions } from "../validation"

export interface AccountsResource {
  /** `GET /accounts` */
  list(options?: MercuryAccountListOptions): Promise<MercuryAccountsResponse>
  /** Cursor iterator over `GET /accounts`. */
  listAll(options?: MercuryAccountListOptions): AsyncIterable<MercuryAccount>
}

export function createAccountsResource(http: MercuryHttp): AccountsResource {
  const resource: AccountsResource = {
    list(options) {
      assertCursorOptions(options)
      return http.get("accounts", cursorQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, (page) => page.accounts, options)
    },
  }

  return resource
}
