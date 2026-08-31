import type { LinkedinHttp } from "../http"
import { listAllOffset } from "../pagination"
import { assertOffset, urnPath, withQuery } from "../restli"
import type { LinkedinOffsetPage, LinkedinOrganizationUrn } from "../types/common"
import type { LinkedinOrganizationAcl, LinkedinOrganizationAclOptions } from "../types/community"
import { type ElementsResponse, offsetPage } from "./community-utils"

export interface OrganizationAclsResource {
  /** Find approved or pending roles held by the authenticated member. */
  listForAuthenticatedMember(
    options?: LinkedinOrganizationAclOptions
  ): Promise<LinkedinOffsetPage<LinkedinOrganizationAcl>>
  listAllForAuthenticatedMember(
    options?: LinkedinOrganizationAclOptions
  ): AsyncIterable<LinkedinOrganizationAcl>
  /** Find members with a role on an organization. */
  listByOrganization(
    organization: LinkedinOrganizationUrn,
    options?: LinkedinOrganizationAclOptions
  ): Promise<LinkedinOffsetPage<LinkedinOrganizationAcl>>
  listAllByOrganization(
    organization: LinkedinOrganizationUrn,
    options?: LinkedinOrganizationAclOptions
  ): AsyncIterable<LinkedinOrganizationAcl>
}

export function createOrganizationAclsResource(http: LinkedinHttp): OrganizationAclsResource {
  const resource: OrganizationAclsResource = {
    listForAuthenticatedMember(options) {
      return list(http, "roleAssignee", undefined, options)
    },
    listAllForAuthenticatedMember(options) {
      return listAllOffset(resource.listForAuthenticatedMember, options)
    },
    listByOrganization(organization, options) {
      urnPath(organization, "organization URN")
      return list(http, "organization", organization, options)
    },
    listAllByOrganization(organization, options) {
      return listAllOffset((page) => resource.listByOrganization(organization, page), options)
    },
  }
  return resource
}

async function list(
  http: LinkedinHttp,
  finder: "roleAssignee" | "organization",
  organization: LinkedinOrganizationUrn | undefined,
  options: LinkedinOrganizationAclOptions | undefined
): Promise<LinkedinOffsetPage<LinkedinOrganizationAcl>> {
  assertOffset(options?.start, "start", 0)
  assertOffset(options?.count, "count", 1)
  const response = await http.get<ElementsResponse<LinkedinOrganizationAcl>>(
    withQuery("organizationAcls", {
      q: finder,
      organization,
      role: options?.role,
      state: options?.state,
      start: options?.start,
      count: options?.count,
    })
  )
  return offsetPage(response, options)
}
