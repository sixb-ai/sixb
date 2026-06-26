import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllOffset } from "../pagination"
import type {
  PipedriveOffsetPage,
  PipedriveResponse,
  PipedriveUser,
  PipedriveUserFindOptions,
  PipedriveUserListOptions,
} from "../types"

export interface UsersResource {
  /** `GET /users` */
  list(options?: PipedriveUserListOptions): Promise<PipedriveOffsetPage<PipedriveUser>>
  listAll(options?: PipedriveUserListOptions): AsyncIterable<PipedriveUser>
  /** `GET /users/find` */
  find(options: PipedriveUserFindOptions): Promise<PipedriveResponse<readonly PipedriveUser[]>>
  /** `GET /users/me` */
  me(): Promise<PipedriveResponse<PipedriveUser>>
  /** `GET /users/{id}` */
  get(id: number): Promise<PipedriveResponse<PipedriveUser>>
}

export function usersResource(http: PipedriveHttp): UsersResource {
  const resource: UsersResource = {
    list(options) {
      return http.get("v1", "users", options)
    },
    listAll(options) {
      return listAllOffset(resource.list, options)
    },
    find(options) {
      return http.get("v1", "users/find", {
        ...options,
        search_by_email:
          typeof options.search_by_email === "boolean"
            ? options.search_by_email
              ? 1
              : 0
            : options.search_by_email,
      })
    },
    me() {
      return http.get("v1", "users/me")
    },
    get(id) {
      return http.get("v1", `users/${pathPart(id, "user id")}`)
    },
  }

  return resource
}
