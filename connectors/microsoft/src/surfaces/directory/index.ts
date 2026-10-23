import type { MicrosoftHttp } from "../../http"
import { type OrgContactsResource, orgContactsResource } from "./contacts"
import { type UsersResource, usersResource } from "./users"

/** Microsoft Entra directory objects, read across the whole tenant. */
export interface DirectorySurface {
  /** Organizational contacts (`/contacts`), not the personal contacts in `client.contacts`. */
  readonly contacts: OrgContactsResource
  /** Member and guest accounts (`/users`). Needs User.Read.All. */
  readonly users: UsersResource
}
export function directorySurface(http: MicrosoftHttp): DirectorySurface {
  return { contacts: orgContactsResource(http), users: usersResource(http) }
}
