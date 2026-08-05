import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  pathPart,
  readJson,
  readPage,
  readPresence,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubPage, GitHubUser } from "../types/common"
import type {
  AuthenticatedUserOrganizationMembershipsApi,
  GitHubOrganizationInvitation,
  GitHubOrganizationMembership,
  ListAuthenticatedUserOrganizationMembershipsOptions,
  ListOrganizationInvitationsOptions,
  ListOrganizationMembersOptions,
  ListOutsideCollaboratorsOptions,
  OrganizationInvitationsApi,
  OrganizationMembersApi,
  OrganizationOutsideCollaboratorsApi,
} from "../types/members"

export function createAuthenticatedUserOrganizationMembershipsApi(
  context: GitHubHttpContext
): AuthenticatedUserOrganizationMembershipsApi {
  return {
    async list(
      options?: ListAuthenticatedUserOrganizationMembershipsOptions
    ): Promise<GitHubPage<GitHubOrganizationMembership>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.state) params.set("state", options.state)
      const path = withQuery("/user/memberships/orgs", params)
      return readPage<GitHubOrganizationMembership>(
        await context.http.get(resolvePagePath(path, options)),
        context.apiBaseUrl
      )
    },

    async get(org: string): Promise<GitHubOrganizationMembership> {
      return readJson<GitHubOrganizationMembership>(
        await context.http.get(`/user/memberships/orgs/${pathPart(org, "org")}`)
      )
    },
  }
}

export function createOrganizationMembersApi(
  context: GitHubHttpContext,
  org: string
): OrganizationMembersApi {
  const orgPath = `/orgs/${pathPart(org, "org")}`
  return {
    async list(options?: ListOrganizationMembersOptions): Promise<GitHubPage<GitHubUser>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.filter) params.set("filter", options.filter)
      if (options?.role) params.set("role", options.role)
      return readUserPage(context, withQuery(`${orgPath}/members`, params), options)
    },

    async listPublic(options): Promise<GitHubPage<GitHubUser>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      return readUserPage(context, withQuery(`${orgPath}/public_members`, params), options)
    },

    async check(username: string): Promise<boolean> {
      return readPresence(
        await context.http.get(`${orgPath}/members/${pathPart(username, "username")}`)
      )
    },

    async checkPublic(username: string): Promise<boolean> {
      return readPresence(
        await context.http.get(`${orgPath}/public_members/${pathPart(username, "username")}`)
      )
    },

    async getMembership(username: string): Promise<GitHubOrganizationMembership> {
      return readJson<GitHubOrganizationMembership>(
        await context.http.get(`${orgPath}/memberships/${pathPart(username, "username")}`)
      )
    },
  }
}

export function createOrganizationOutsideCollaboratorsApi(
  context: GitHubHttpContext,
  org: string
): OrganizationOutsideCollaboratorsApi {
  const path = `/orgs/${pathPart(org, "org")}/outside_collaborators`
  return {
    async list(options?: ListOutsideCollaboratorsOptions): Promise<GitHubPage<GitHubUser>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.filter) params.set("filter", options.filter)
      return readUserPage(context, withQuery(path, params), options)
    },
  }
}

export function createOrganizationInvitationsApi(
  context: GitHubHttpContext,
  org: string
): OrganizationInvitationsApi {
  const path = `/orgs/${pathPart(org, "org")}/invitations`
  return {
    async list(
      options?: ListOrganizationInvitationsOptions
    ): Promise<GitHubPage<GitHubOrganizationInvitation>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.role) params.set("role", options.role)
      if (options?.invitationSource) params.set("invitation_source", options.invitationSource)
      return readPage<GitHubOrganizationInvitation>(
        await context.http.get(resolvePagePath(withQuery(path, params), options)),
        context.apiBaseUrl
      )
    },
  }
}

function readUserPage(
  context: GitHubHttpContext,
  path: string,
  options?: { readonly pageToken?: string }
): Promise<GitHubPage<GitHubUser>> {
  return context.http
    .get(resolvePagePath(path, options))
    .then((response) => readPage<GitHubUser>(response, context.apiBaseUrl))
}
