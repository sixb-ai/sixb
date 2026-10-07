import type { MicrosoftHttp } from "../../http"
import { type OrgContactsResource, orgContactsResource } from "./contacts"

/** Microsoft Entra directory objects, read across the whole tenant. */
export interface DirectorySurface {
  /** Organizational contacts (`/contacts`), not the personal contacts in `client.contacts`. */
  readonly contacts: OrgContactsResource
}
export function directorySurface(http: MicrosoftHttp): DirectorySurface {
  return { contacts: orgContactsResource(http) }
}
