import type { RestClient } from "@sixb/connector-rest"
import {
  createAuthenticatedUserIssuesApi,
  createOrganizationIssuesApi,
  createRepositoryIssuesApi,
} from "./resources/issues"
import {
  createAuthenticatedUserOrganizationMembershipsApi,
  createOrganizationInvitationsApi,
  createOrganizationMembersApi,
  createOrganizationOutsideCollaboratorsApi,
} from "./resources/members"
import {
  createAuthenticatedUserRepositoriesApi,
  createOrganizationRepositoriesApi,
  createRepositoryApi,
} from "./resources/repos"
import { createGitHubUsersApi } from "./resources/users"
import type { GitHubClient } from "./types/client"

export function createGitHubClient(http: RestClient, apiBaseUrl: URL): GitHubClient {
  const context = { http, apiBaseUrl }
  return {
    repos: createAuthenticatedUserRepositoriesApi(context),
    issues: createAuthenticatedUserIssuesApi(context),
    users: createGitHubUsersApi(context),
    memberships: createAuthenticatedUserOrganizationMembershipsApi(context),
    repo: (target) => ({
      ...createRepositoryApi(context, target),
      issues: createRepositoryIssuesApi(context, target),
    }),
    org: (org) => ({
      repos: createOrganizationRepositoriesApi(context, org),
      issues: createOrganizationIssuesApi(context, org),
      members: createOrganizationMembersApi(context, org),
      outsideCollaborators: createOrganizationOutsideCollaboratorsApi(context, org),
      invitations: createOrganizationInvitationsApi(context, org),
    }),
  }
}
