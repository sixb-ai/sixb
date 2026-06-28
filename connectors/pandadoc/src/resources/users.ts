import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import { listAllPages } from "../pagination"
import type {
  PandaDocResultsResponse,
  PandaDocUser,
  PandaDocUserCreateOptions,
  PandaDocUserInput,
  PandaDocUserListOptions,
} from "../types"

export interface UsersResource {
  /** `GET /public/v1/users` */
  list(options?: PandaDocUserListOptions): Promise<PandaDocResultsResponse<PandaDocUser>>
  listAll(options?: PandaDocUserListOptions): AsyncIterable<PandaDocUser>
  /** `POST /public/v1/users` */
  create(input: PandaDocUserInput, options?: PandaDocUserCreateOptions): Promise<PandaDocUser>
  /** `GET /public/v1/users/{user_id}` */
  get(userId: string): Promise<PandaDocUser>
}

export function usersResource(http: PandaDocHttp): UsersResource {
  const resource: UsersResource = {
    list(options) {
      return http.get("public/v1/users", options)
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.results, options)
    },
    create(input, options) {
      return http.post("public/v1/users", input, options)
    },
    get(userId) {
      return http.get(`public/v1/users/${pathPart(userId, "user id")}`)
    },
  }

  return resource
}
