import type { MicrosoftHttp } from "../../http"
import type { SelectOptions } from "../../types/common"
import type { DirectoryPage, DirectoryQueryOptions, User } from "../../types/directory"
import { odataString, query, resource, segment } from "../../validation"
import { directoryList, directoryListAll } from "./query"

export interface UsersResource {
  list(options?: DirectoryQueryOptions): Promise<DirectoryPage<User>>
  listAll(options?: DirectoryQueryOptions): AsyncIterable<User>
  /** Graph answers 404 when no user has this ID or UPN. */
  get(idOrUserPrincipalName: string, options?: SelectOptions): Promise<User>
}

// Graph reads `users/$x@contoso.com` as a system query option and answers 400, encoded or not.
// It documents the key form `users('$x@contoso.com')` for these UPNs.
const userPath = (id: string) =>
  id.startsWith("$")
    ? `users(${segment(odataString(id), "user ID or UPN")})`
    : `users/${segment(id, "user ID or UPN")}`

export function usersResource(http: MicrosoftHttp): UsersResource {
  return {
    list: async (options) => directoryList(http, "users", options),
    listAll: (options) => directoryListAll(http, "users", options),
    async get(id, options) {
      return resource(
        await http.json(`${userPath(id)}${query(options)}`, { signal: options?.signal })
      )
    },
  }
}
