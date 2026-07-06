import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocContact,
  PandaDocContactInput,
  PandaDocContactListOptions,
  PandaDocResultsResponse,
  QueryParams,
} from "../types"

export interface ContactsResource {
  /** `GET /public/v1/contacts` */
  list(options?: PandaDocContactListOptions): Promise<PandaDocResultsResponse<PandaDocContact>>
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
  return {
    list(options) {
      return http.get("public/v1/contacts", options as QueryParams | undefined)
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
}
