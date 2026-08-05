import type { GoogleHttp } from "../../../http"
import type { ForwardingAddress, ListForwardingAddressesResponse } from "../../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "../paths"

const COLLECTION = "settings/forwardingAddresses"

export interface GmailForwardingAddressesResource {
  list(userId: string): Promise<ListForwardingAddressesResponse>
  get(userId: string, forwardingEmail: string): Promise<ForwardingAddress>
  create(userId: string, forwardingAddress: ForwardingAddress): Promise<ForwardingAddress>
  delete(userId: string, forwardingEmail: string): Promise<void>
}

export function gmailForwardingAddressesResource(
  http: GoogleHttp
): GmailForwardingAddressesResource {
  return {
    list(userId) {
      return http.json<ListForwardingAddressesResponse>(
        "gmail",
        "GET",
        gmailCollectionPath(userId, COLLECTION)
      )
    },
    get(userId, forwardingEmail) {
      return http.json<ForwardingAddress>(
        "gmail",
        "GET",
        gmailResourcePath(userId, COLLECTION, forwardingEmail, "forwardingEmail")
      )
    },
    create(userId, forwardingAddress) {
      return http.json<ForwardingAddress>(
        "gmail",
        "POST",
        gmailCollectionPath(userId, COLLECTION),
        { body: forwardingAddress }
      )
    },
    delete(userId, forwardingEmail) {
      return http.json<void>(
        "gmail",
        "DELETE",
        gmailResourcePath(userId, COLLECTION, forwardingEmail, "forwardingEmail")
      )
    },
  }
}
