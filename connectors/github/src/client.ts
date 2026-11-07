import type { RestClient } from "@sixb/connector-rest"
import { createGitHubAttachmentsApi } from "./resources/attachments"
import { createRepositoryBranchesApi } from "./resources/branches"
import { createRepositoryCommitsApi } from "./resources/commits"
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
import { createRepositoryPullRequestsApi } from "./resources/pulls"
import { createRepositoryReleasesApi } from "./resources/releases"
import {
  createAuthenticatedUserRepositoriesApi,
  createOrganizationRepositoriesApi,
  createRepositoryApi,
} from "./resources/repos"
import { createRepositoryStacksApi } from "./resources/stacks"
import { createGitHubUsersApi } from "./resources/users"
import type { GitHubClient } from "./types/client"

export function createGitHubClient(http: RestClient, apiBaseUrl: URL): GitHubClient {
  const context = { http, apiBaseUrl }
  return {
    repos: createAuthenticatedUserRepositoriesApi(context),
    issues: createAuthenticatedUserIssuesApi(context),
    users: createGitHubUsersApi(context),
    memberships: createAuthenticatedUserOrganizationMembershipsApi(context),
    attachments: createGitHubAttachmentsApi(context),
    repo: (target) => ({
      ...createRepositoryApi(context, target),
      branches: createRepositoryBranchesApi(context, target),
      commits: createRepositoryCommitsApi(context, target),
      issues: createRepositoryIssuesApi(context, target),
      pulls: createRepositoryPullRequestsApi(context, target),
      stacks: createRepositoryStacksApi(context, target),
      releases: createRepositoryReleasesApi(context, target),
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
