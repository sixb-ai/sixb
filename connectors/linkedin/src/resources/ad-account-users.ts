import type { LinkedinHttp } from "../http"
import { listAllOffset } from "../pagination"
import { assertOffset, urnPath, withQuery } from "../restli"
import type { LinkedinAdAccountUser, LinkedinAdAccountUserInput } from "../types/advertising"
import type {
  LinkedinOffsetOptions,
  LinkedinOffsetPage,
  LinkedinPaging,
  LinkedinPersonUrn,
  LinkedinSponsoredAccountUrn,
} from "../types/common"

export interface AdAccountUsersResource {
  /** `GET /adAccountUsers/(account=...,user=...)` */
  get(account: LinkedinSponsoredAccountUrn, user: LinkedinPersonUrn): Promise<LinkedinAdAccountUser>
  /** `GET /adAccountUsers?q=authenticatedUser` */
  listByAuthenticatedUser(
    options?: LinkedinOffsetOptions
  ): Promise<LinkedinOffsetPage<LinkedinAdAccountUser>>
  listAllByAuthenticatedUser(options?: LinkedinOffsetOptions): AsyncIterable<LinkedinAdAccountUser>
  /** `GET /adAccountUsers?q=accounts&accounts=...` */
  listByAccount(
    account: LinkedinSponsoredAccountUrn,
    options?: LinkedinOffsetOptions
  ): Promise<LinkedinOffsetPage<LinkedinAdAccountUser>>
  listAllByAccount(
    account: LinkedinSponsoredAccountUrn,
    options?: LinkedinOffsetOptions
  ): AsyncIterable<LinkedinAdAccountUser>
  /** `PUT /adAccountUsers/(account=...,user=...)` */
  grant(input: LinkedinAdAccountUserInput): Promise<void>
  /** `POST /adAccountUsers/(account=...,user=...)` */
  update(input: LinkedinAdAccountUserInput): Promise<void>
  /** `DELETE /adAccountUsers/(account=...,user=...)` */
  revoke(account: LinkedinSponsoredAccountUrn, user: LinkedinPersonUrn): Promise<void>
}

interface ListResponse {
  readonly elements?: readonly LinkedinAdAccountUser[]
  readonly paging?: LinkedinPaging
}

export function createAdAccountUsersResource(http: LinkedinHttp): AdAccountUsersResource {
  const resource: AdAccountUsersResource = {
    get(account, user) {
      return http.get(compoundPath(account, user))
    },
    listByAuthenticatedUser(options) {
      return list(http, "authenticatedUser", undefined, options)
    },
    listAllByAuthenticatedUser(options) {
      return listAllOffset(resource.listByAuthenticatedUser, options)
    },
    listByAccount(account, options) {
      urnPath(account, "ad account URN")
      return list(http, "accounts", account, options)
    },
    listAllByAccount(account, options) {
      return listAllOffset((page) => resource.listByAccount(account, page), options)
    },
    grant(input) {
      return http.put(compoundPath(input.account, input.user), input)
    },
    update(input) {
      return http.post(compoundPath(input.account, input.user), {
        patch: { $set: input },
      })
    },
    revoke(account, user) {
      return http.delete(compoundPath(account, user))
    },
  }
  return resource
}

async function list(
  http: LinkedinHttp,
  finder: "authenticatedUser" | "accounts",
  account: LinkedinSponsoredAccountUrn | undefined,
  options: LinkedinOffsetOptions | undefined
): Promise<LinkedinOffsetPage<LinkedinAdAccountUser>> {
  assertOffset(options?.start, "start", 0)
  assertOffset(options?.count, "count", 1)
  const response = await http.get<ListResponse>(
    withQuery("adAccountUsers", {
      q: finder,
      accounts: account,
      start: options?.start,
      count: options?.count,
    })
  )
  return {
    items: response.elements ?? [],
    paging: response.paging ?? {
      start: options?.start ?? 0,
      count: response.elements?.length ?? 0,
    },
  }
}

function compoundPath(account: LinkedinSponsoredAccountUrn, user: LinkedinPersonUrn): string {
  urnPath(account, "ad account URN")
  urnPath(user, "person URN")
  return `adAccountUsers/(account=${encodeURIComponent(account)},user=${encodeURIComponent(user)})`
}
