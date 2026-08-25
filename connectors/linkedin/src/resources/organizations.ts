import type { LinkedinHttp } from "../http"
import { listAllOffset } from "../pagination"
import { assertNonEmpty, assertOffset, pathId, urnPath, withQuery } from "../restli"
import type {
  LinkedinId,
  LinkedinOffsetOptions,
  LinkedinOffsetPage,
  LinkedinOrganizationUrn,
} from "../types/common"
import type { LinkedinOrganization } from "../types/community"
import { type ElementsResponse, offsetPage } from "./community-utils"

export interface OrganizationsResource {
  /** Get an organization administered by the authenticated member. */
  get(id: LinkedinId): Promise<LinkedinOrganization>
  findByVanityName(vanityName: string): Promise<LinkedinOrganization | undefined>
  listByParent(
    parent: LinkedinOrganizationUrn,
    options?: LinkedinOffsetOptions
  ): Promise<LinkedinOffsetPage<LinkedinOrganization>>
  listAllByParent(
    parent: LinkedinOrganizationUrn,
    options?: LinkedinOffsetOptions
  ): AsyncIterable<LinkedinOrganization>
  /** Current organization follower count from `/networkSizes`. */
  followerCount(organization: LinkedinOrganizationUrn): Promise<number>
}

export function createOrganizationsResource(http: LinkedinHttp): OrganizationsResource {
  const resource: OrganizationsResource = {
    get(id) {
      return http.get(`organizations/${pathId(id, "organization id")}`)
    },
    async findByVanityName(vanityName) {
      assertNonEmpty(vanityName, "organization vanity name")
      const response = await http.get<ElementsResponse<LinkedinOrganization>>(
        withQuery("organizations", { q: "vanityName", vanityName })
      )
      return response.elements?.[0]
    },
    listByParent(parent, options) {
      urnPath(parent, "parent organization URN")
      return listByParent(http, parent, options)
    },
    listAllByParent(parent, options) {
      return listAllOffset((page) => resource.listByParent(parent, page), options)
    },
    async followerCount(organization) {
      urnPath(organization, "organization URN")
      const response = await http.get<{ readonly firstDegreeSize: number }>(
        withQuery(`networkSizes/${encodeURIComponent(organization)}`, {
          edgeType: "COMPANY_FOLLOWED_BY_MEMBER",
        })
      )
      return response.firstDegreeSize
    },
  }
  return resource
}

async function listByParent(
  http: LinkedinHttp,
  parent: LinkedinOrganizationUrn,
  options: LinkedinOffsetOptions | undefined
): Promise<LinkedinOffsetPage<LinkedinOrganization>> {
  assertOffset(options?.start, "start", 0)
  assertOffset(options?.count, "count", 1)
  const response = await http.get<ElementsResponse<LinkedinOrganization>>(
    withQuery("organizations", {
      q: "parentOrganization",
      parent,
      start: options?.start,
      count: options?.count,
    })
  )
  return offsetPage(response, options)
}
