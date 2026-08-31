import type { LinkedinHttp } from "../http"
import { listAllCursor } from "../pagination"
import { assertPageSize, restliList, urnPath, withQuery } from "../restli"
import type {
  LinkedinCreateCreativeInput,
  LinkedinCreateInlineCreativeInput,
  LinkedinCreative,
  LinkedinCreativeContent,
  LinkedinCreativeSearchOptions,
  LinkedinUpdateCreativeInput,
} from "../types/advertising"
import type {
  LinkedinCreatedEntity,
  LinkedinCursorPage,
  LinkedinSponsoredCreativeUrn,
} from "../types/common"
import { sponsoredCreativeUrn } from "../urns"

export interface CreativesResource {
  get<TContent extends LinkedinCreativeContent = LinkedinCreativeContent>(
    id: LinkedinSponsoredCreativeUrn
  ): Promise<LinkedinCreative<TContent>>
  search(options?: LinkedinCreativeSearchOptions): Promise<LinkedinCursorPage<LinkedinCreative>>
  searchAll(options?: LinkedinCreativeSearchOptions): AsyncIterable<LinkedinCreative>
  create<TContent extends LinkedinCreativeContent = LinkedinCreativeContent>(
    input: LinkedinCreateCreativeInput<TContent>
  ): Promise<LinkedinCreatedEntity<LinkedinSponsoredCreativeUrn>>
  /** Create a creative and its post in one `action=createInline` request. */
  createInline(
    input: LinkedinCreateInlineCreativeInput
  ): Promise<LinkedinCreatedEntity<LinkedinSponsoredCreativeUrn>>
  update(id: LinkedinSponsoredCreativeUrn, input: LinkedinUpdateCreativeInput): Promise<void>
  deleteDraft(id: LinkedinSponsoredCreativeUrn): Promise<void>
}

interface SearchResponse {
  readonly elements?: readonly LinkedinCreative[]
  readonly metadata?: {
    readonly nextPageToken?: string
    readonly totalResultCount?: number
  }
}

export function createCreativesResource(http: LinkedinHttp, accountId: string): CreativesResource {
  const path = `adAccounts/${accountId}/creatives`
  const resource: CreativesResource = {
    get(id) {
      return http.get(`${path}/${urnPath(id, "creative URN")}`)
    },
    async search(options) {
      assertPageSize(options?.pageSize, 100)
      const response = await http.get<SearchResponse>(
        withQuery(path, {
          q: "criteria",
          campaigns: list(options?.campaigns),
          contentReferences: list(options?.contentReferences),
          creatives: list(options?.creatives),
          intendedStatuses: list(options?.intendedStatuses),
          isTestAccount: options?.isTestAccount,
          isTotalIncluded: options?.isTotalIncluded,
          leadgenCreativeCallToActionDestinations: list(
            options?.leadgenCreativeCallToActionDestinations
          ),
          sortOrder: options?.sortOrder,
          pageSize: options?.pageSize,
          pageToken: options?.pageToken,
        }),
        { headers: { "X-RestLi-Method": "FINDER" } }
      )
      return {
        items: response.elements ?? [],
        nextPageToken: response.metadata?.nextPageToken,
        totalCount: response.metadata?.totalResultCount,
      }
    },
    searchAll(options) {
      return listAllCursor(resource.search, options)
    },
    async create(input) {
      const created = await http.create(path, input)
      return { id: sponsoredCreativeUrn(created.id) }
    },
    async createInline(input) {
      const created = await http.create(withQuery(path, { action: "createInline" }), input)
      return { id: sponsoredCreativeUrn(created.id) }
    },
    update(id, input) {
      if (Object.keys(input).length === 0) {
        return Promise.reject(
          new Error("[SixbLinkedin] creative update must set at least one field.")
        )
      }
      return http.post(
        `${path}/${urnPath(id, "creative URN")}`,
        { patch: { $set: input } },
        { headers: { "X-RestLi-Method": "PARTIAL_UPDATE" } }
      )
    },
    deleteDraft(id) {
      return http.delete(`${path}/${urnPath(id, "creative URN")}`, {
        headers: { "X-RestLi-Method": "DELETE" },
      })
    },
  }
  return resource
}

function list(values: readonly (string | number)[] | undefined) {
  return values?.length ? restliList(values) : undefined
}
