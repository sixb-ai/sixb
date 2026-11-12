import type { CtmHttp } from "../http"
import type {
  CtmAccount,
  CtmAccountListOptions,
  CtmAccountStatus,
  CtmAccountSummary,
  CtmAgency,
  CtmId,
} from "../types"
import { pathId } from "../validation"
import { type CtmReadMethods, readMethods } from "./shared"

/**
 * `GET /accounts` and `/accounts/{id}` — the accounts the key reaches: one for an account key,
 * every sub-account for an agency key.
 */
export interface AccountsResource extends CtmReadMethods<CtmAccount, CtmAccountListOptions> {
  /** `GET /accounts?names=1&all=1` — the ID and name of every active account, in one call. */
  listNames(): Promise<readonly CtmAccountSummary[]>
  /** `GET /accounts/{id}/status` */
  status(accountId: CtmId): Promise<CtmAccountStatus>
}

export function accountsResource(http: CtmHttp): AccountsResource {
  return {
    ...readMethods<CtmAccount, CtmAccountListOptions>(
      http,
      (suffix) => suffix,
      "accounts",
      "accounts",
      "accountId",
      (options) => ({ status: options?.status })
    ),

    async listNames() {
      const body = await http.get<{ readonly accounts?: readonly CtmAccountSummary[] }>(
        "accounts.json",
        { names: 1, all: 1 }
      )

      return body?.accounts ?? []
    },

    async status(accountId) {
      return http.get<CtmAccountStatus>(`accounts/${pathId(accountId, "accountId")}/status`)
    },
  }
}

/** `GET /agency` — the agency an agency key belongs to. */
export interface AgencyResource {
  get(): Promise<CtmAgency>
}

export function agencyResource(http: CtmHttp): AgencyResource {
  return {
    async get() {
      const body = await http.get<{ readonly agency?: CtmAgency }>("agency")

      if (!body?.agency) {
        throw new Error("[SixbCtm] CTM answered the agency request without the agency.")
      }

      return body.agency
    },
  }
}
