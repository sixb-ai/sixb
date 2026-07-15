import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderContact,
  TeamleaderContactListItem,
  TeamleaderListResponse,
  TeamleaderSingleResponse,
  TeamleaderTypeAndId,
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
    add(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderTypeAndId<"contact">>>(
        "/contacts.add",
        body,
        requestOptions
      )
    },
    update(body, requestOptions) {
      return request<void>("/contacts.update", body, requestOptions)
    },
    delete(body, requestOptions) {
      return request<void>("/contacts.delete", body, requestOptions)
    },
    tag(body, requestOptions) {
      return request<void>("/contacts.tag", body, requestOptions)
    },
    untag(body, requestOptions) {
      return request<void>("/contacts.untag", body, requestOptions)
    },
    linkToCompany(body, requestOptions) {
      return request<void>("/contacts.linkToCompany", body, requestOptions)
    },
    unlinkFromCompany(body, requestOptions) {
      return request<void>("/contacts.unlinkFromCompany", body, requestOptions)
    },
    updateCompanyLink(body, requestOptions) {
      return request<void>("/contacts.updateCompanyLink", body, requestOptions)
    },
    uploadAvatar(body, requestOptions) {
      return request<void>("/contacts.uploadAvatar", body, requestOptions)
    },
  }

  return resource
}
