import type { GitHubRepositoryTarget } from "./common"
import type {
  AuthenticatedUserIssuesApi,
  OrganizationIssuesApi,
  RepositoryIssuesApi,
} from "./issues"
import type {
  AuthenticatedUserOrganizationMembershipsApi,
  OrganizationInvitationsApi,
  OrganizationMembersApi,
  OrganizationOutsideCollaboratorsApi,
} from "./members"
import type { RepositoryReleasesApi } from "./releases"
import type {
  AuthenticatedUserRepositoriesApi,
  GitHubRepository,
  OrganizationRepositoriesApi,
} from "./repos"
import type { GitHubUsersApi } from "./users"

export interface GitHubClient {
  readonly repos: AuthenticatedUserRepositoriesApi
  readonly issues: AuthenticatedUserIssuesApi
  readonly users: GitHubUsersApi
  readonly memberships: AuthenticatedUserOrganizationMembershipsApi
  repo(target: GitHubRepositoryTarget): GitHubRepositoryScope
  org(org: string): GitHubOrganizationScope
}

export interface GitHubRepositoryScope {
  readonly issues: RepositoryIssuesApi
  readonly releases: RepositoryReleasesApi
  get(): Promise<GitHubRepository>
}

export interface GitHubOrganizationScope {
  readonly repos: OrganizationRepositoriesApi
  readonly issues: OrganizationIssuesApi
  readonly members: OrganizationMembersApi
  readonly outsideCollaborators: OrganizationOutsideCollaboratorsApi
  readonly invitations: OrganizationInvitationsApi
}
