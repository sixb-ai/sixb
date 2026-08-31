import type { LinkedinHttp } from "../http"
import { listAllCursor } from "../pagination"
import { assertNonEmpty, assertPageSize, pathId, restliSearch, withQuery } from "../restli"
import type {
  LinkedinAdAccount,
  LinkedinAdAccountSearchOptions,
  LinkedinCreateAdAccountInput,
  LinkedinUpdateAdAccountInput,
} from "../types/advertising"
import type { LinkedinCreatedEntity, LinkedinCursorPage, LinkedinId } from "../types/common"

export interface AdAccountsResource {
  /** `GET /adAccounts/{id}` */
  get(id: LinkedinId): Promise<LinkedinAdAccount>
  /** `GET /adAccounts?q=search` */
  search(options?: LinkedinAdAccountSearchOptions): Promise<LinkedinCursorPage<LinkedinAdAccount>>
  searchAll(options?: LinkedinAdAccountSearchOptions): AsyncIterable<LinkedinAdAccount>
  /** `POST /adAccounts` */
  create(input: LinkedinCreateAdAccountInput): Promise<LinkedinCreatedEntity>
  /** `POST /adAccounts/{id}` with `PARTIAL_UPDATE`. */
  update(id: LinkedinId, input: LinkedinUpdateAdAccountInput): Promise<void>
  /** Permanently delete a DRAFT account. Non-draft accounts must be marked PENDING_DELETION. */
  deleteDraft(id: LinkedinId): Promise<void>
}

interface SearchResponse {
  readonly elements?: readonly LinkedinAdAccount[]
  readonly metadata?: { readonly nextPageToken?: string }
}

export function createAdAccountsResource(http: LinkedinHttp): AdAccountsResource {
  const resource: AdAccountsResource = {
    get(id) {
      return http.get(`adAccounts/${pathId(id, "ad account id")}`)
    },
    async search(options) {
      assertPageSize(options?.pageSize, 1_000)
      const response = await http.get<SearchResponse>(
        withQuery("adAccounts", {
          q: "search",
          search: restliSearch({
            id: options?.ids,
            name: options?.names,
            reference: options?.references,
            status: options?.statuses,
            type: options?.types,
            test: options?.test,
          }),
          sortOrder: options?.sortOrder,
          pageSize: options?.pageSize,
          pageToken: options?.pageToken,
        })
      )
      return {
        items: response.elements ?? [],
        nextPageToken: response.metadata?.nextPageToken,
      }
    },
    searchAll(options) {
      return listAllCursor(resource.search, options)
    },
    create(input) {
      assertNonEmpty(input.name, "ad account name")
      return http.create("adAccounts", input)
    },
    update(id, input) {
      return http.post(`adAccounts/${pathId(id, "ad account id")}`, patch(input), {
        headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
      })
    },
    deleteDraft(id) {
      return http.delete(`adAccounts/${pathId(id, "ad account id")}`)
    },
  }
  return resource
}

function patch(input: LinkedinUpdateAdAccountInput): {
  readonly patch: { readonly $set: unknown }
} {
  if (Object.keys(input).length === 0) {
    throw new Error("[SixbLinkedin] ad account update must set at least one field.")
  }
  return { patch: { $set: input } }
}
