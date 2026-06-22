import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderContact,
  TeamleaderContactListItem,
  TeamleaderListResponse,
  TeamleaderSingleResponse,
} from "../types"

export function createContactsResource(request: TeamleaderRequester): TeamleaderClient["contacts"] {
  const resource: TeamleaderClient["contacts"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderContactListItem>>(
        "/contacts.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
    info(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderContact>>(
        "/contacts.info",
        body,
        requestOptions
      )
    },
  }

  return resource
}
