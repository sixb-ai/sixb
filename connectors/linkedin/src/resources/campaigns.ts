import type { LinkedinHttp } from "../http"
import { listAllCursor } from "../pagination"
import { assertNonEmpty, assertPageSize, pathId, restliSearch, withQuery } from "../restli"
import type {
  LinkedinCampaign,
  LinkedinCampaignSearchOptions,
  LinkedinCreateCampaignInput,
  LinkedinUpdateCampaignInput,
} from "../types/advertising"
import type { LinkedinCreatedEntity, LinkedinCursorPage, LinkedinId } from "../types/common"

export interface CampaignsResource {
  get(id: LinkedinId): Promise<LinkedinCampaign>
  search(options: LinkedinCampaignSearchOptions): Promise<LinkedinCursorPage<LinkedinCampaign>>
  searchAll(options: LinkedinCampaignSearchOptions): AsyncIterable<LinkedinCampaign>
  create(input: LinkedinCreateCampaignInput): Promise<LinkedinCreatedEntity>
  update(
    id: LinkedinId,
    input: LinkedinUpdateCampaignInput,
    deleteFields?: readonly (keyof LinkedinUpdateCampaignInput)[]
  ): Promise<void>
  deleteDraft(id: LinkedinId): Promise<void>
}

interface SearchResponse {
  readonly elements?: readonly LinkedinCampaign[]
  readonly metadata?: { readonly nextPageToken?: string }
}

export function createCampaignsResource(http: LinkedinHttp, accountId: string): CampaignsResource {
  const path = `adAccounts/${accountId}/adCampaigns`
  const resource: CampaignsResource = {
    get(id) {
      return http.get(`${path}/${pathId(id, "campaign id")}`)
    },
    async search(options) {
      assertSearch(options)
      assertPageSize(options.pageSize, 1_000)
      const response = await http.get<SearchResponse>(
        withQuery(path, {
          q: "search",
          search: restliSearch({
            id: options.ids,
            campaignGroup: options.campaignGroups,
            associatedEntity: options.associatedEntities,
            name: options.names,
            status: options.statuses,
            type: options.types,
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
    async create(input) {
      assertNonEmpty(input.name, "campaign name")
      assertRunSchedule(input.runSchedule)
      return http.create(path, input)
    },
    update(id, input, deleteFields) {
      if (Object.keys(input).length === 0 && !deleteFields?.length) {
        return Promise.reject(
          new Error("[SixbLinkedin] campaign update must change at least one field.")
        )
      }
      return http.post(
        `${path}/${pathId(id, "campaign id")}`,
        { patch: { $set: input, $delete: deleteFields } },
        { headers: { "X-RestLi-Method": "PARTIAL_UPDATE" } }
      )
    },
    deleteDraft(id) {
      return http.delete(`${path}/${pathId(id, "campaign id")}`)
    },
  }
  return resource
}

function assertRunSchedule(
  runSchedule: LinkedinCreateCampaignInput["runSchedule"] | undefined
): void {
  if (!runSchedule || !Number.isFinite(runSchedule.start)) {
    throw new Error(
      "[SixbLinkedin] campaign runSchedule.start is required and must be a finite timestamp."
    )
  }
}

function assertSearch(options: LinkedinCampaignSearchOptions): void {
  if (
    !options.ids?.length &&
    !options.campaignGroups?.length &&
    !options.associatedEntities?.length &&
    !options.names?.length &&
    !options.statuses?.length &&
    !options.types?.length &&
    options.test === undefined
  ) {
    throw new Error("[SixbLinkedin] campaign search requires at least one criterion.")
  }
}
