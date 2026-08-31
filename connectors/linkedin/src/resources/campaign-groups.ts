import type { LinkedinHttp } from "../http"
import { listAllCursor } from "../pagination"
import { assertNonEmpty, assertPageSize, pathId, restliSearch, withQuery } from "../restli"
import type {
  LinkedinCampaignGroup,
  LinkedinCampaignGroupSearchOptions,
  LinkedinCreateCampaignGroupInput,
  LinkedinUpdateCampaignGroupInput,
} from "../types/advertising"
import type { LinkedinCreatedEntity, LinkedinCursorPage, LinkedinId } from "../types/common"

export interface CampaignGroupsResource {
  get(id: LinkedinId): Promise<LinkedinCampaignGroup>
  search(
    options: LinkedinCampaignGroupSearchOptions
  ): Promise<LinkedinCursorPage<LinkedinCampaignGroup>>
  searchAll(options: LinkedinCampaignGroupSearchOptions): AsyncIterable<LinkedinCampaignGroup>
  create(input: LinkedinCreateCampaignGroupInput): Promise<LinkedinCreatedEntity>
  update(
    id: LinkedinId,
    input: LinkedinUpdateCampaignGroupInput,
    deleteFields?: readonly (keyof LinkedinUpdateCampaignGroupInput)[]
  ): Promise<void>
  deleteDraft(id: LinkedinId): Promise<void>
}

interface SearchResponse {
  readonly elements?: readonly LinkedinCampaignGroup[]
  readonly metadata?: { readonly nextPageToken?: string }
}

export function createCampaignGroupsResource(
  http: LinkedinHttp,
  accountId: string
): CampaignGroupsResource {
  const path = `adAccounts/${accountId}/adCampaignGroups`
  const resource: CampaignGroupsResource = {
    get(id) {
      return http.get(`${path}/${pathId(id, "campaign group id")}`)
    },
    async search(options) {
      assertSearch(options)
      assertPageSize(options.pageSize, 1_000)
      const response = await http.get<SearchResponse>(
        withQuery(path, {
          q: "search",
          search: restliSearch({
            id: options.ids,
            name: options.names,
            status: options.statuses,
            test: options.test,
          }),
          sortOrder: options.sortOrder,
          pageSize: options.pageSize,
          pageToken: options.pageToken,
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
      assertNonEmpty(input.name, "campaign group name")
      return http.create(path, input)
    },
    update(id, input, deleteFields) {
      if (Object.keys(input).length === 0 && !deleteFields?.length) {
        return Promise.reject(
          new Error("[SixbLinkedin] campaign group update must change at least one field.")
        )
      }
      return http.post(
        `${path}/${pathId(id, "campaign group id")}`,
        { patch: { $set: input, $delete: deleteFields } },
        { headers: { "X-RestLi-Method": "PARTIAL_UPDATE" } }
      )
    },
    deleteDraft(id) {
      return http.delete(`${path}/${pathId(id, "campaign group id")}`)
    },
  }
  return resource
}

function assertSearch(options: LinkedinCampaignGroupSearchOptions): void {
  if (
    !options.ids?.length &&
    !options.names?.length &&
    !options.statuses?.length &&
    options.test === undefined
  ) {
    throw new Error("[SixbLinkedin] campaign group search requires at least one criterion.")
  }
}
