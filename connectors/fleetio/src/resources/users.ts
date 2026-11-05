import type { FleetioHttp } from "../http"
import type { FleetioCurrentUser } from "../types"

export interface UsersResource {
  /** `GET /users/me`. The user the API key belongs to, which also proves the credentials work. */
  me(): Promise<FleetioCurrentUser>
}

export function usersResource(http: FleetioHttp): UsersResource {
  return {
    me() {
      return http.get("users/me")
    },
  }
}
