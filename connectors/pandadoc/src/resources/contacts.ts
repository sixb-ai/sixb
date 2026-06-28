import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import { listAllPages } from "../pagination"
import type {
  PandaDocContact,
  PandaDocContactInput,
  PandaDocContactListOptions,
  PandaDocResultsResponse,
} from "../types"

export interface ContactsResource {
  /** `GET /public/v1/contacts` */
  list(options?: PandaDocContactListOptions): Promise<PandaDocResultsResponse<PandaDocContact>>
  listAll(options?: PandaDocContactListOptions): AsyncIterable<PandaDocContact>
  /** `POST /public/v1/contacts` */
  create(input: PandaDocContactInput): Promise<PandaDocContact>
  /** `GET /public/v1/contacts/{id}` */
  get(id: string): Promise<PandaDocContact>
  /** `PATCH /public/v1/contacts/{id}` */
  update(id: string, input: Partial<PandaDocContactInput>): Promise<PandaDocContact>
  /** `DELETE /public/v1/contacts/{id}` */
  delete(id: string): Promise<void>
}

export function contactsResource(http: PandaDocHttp): ContactsResource {
  const resource: ContactsResource = {
    list(options) {
      return http.get("public/v1/contacts", options)
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.results, options)
    },
    create(input) {
      return http.post("public/v1/contacts", input)
    },
    get(id) {
      return http.get(`public/v1/contacts/${pathPart(id, "contact id")}`)
    },
    update(id, input) {
      return http.patch(`public/v1/contacts/${pathPart(id, "contact id")}`, input)
    },
    delete(id) {
      return http.delete(`public/v1/contacts/${pathPart(id, "contact id")}`)
    },
  }

  return resource
}
