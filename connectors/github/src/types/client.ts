import type { GitHubAttachmentsApi } from "./attachments"
import type { RepositoryBranchesApi } from "./branches"
import type { RepositoryCommitsApi } from "./commits"
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
import type { RepositoryPullRequestsApi } from "./pulls"
import type { RepositoryReleasesApi } from "./releases"
import type {
  AuthenticatedUserRepositoriesApi,
  GitHubRepository,
  OrganizationRepositoriesApi,
} from "./repos"
import type { RepositoryStacksApi } from "./stacks"
import type { GitHubUsersApi } from "./users"

export interface GitHubClient {
  readonly repos: AuthenticatedUserRepositoriesApi
  readonly issues: AuthenticatedUserIssuesApi
  readonly users: GitHubUsersApi
  readonly memberships: AuthenticatedUserOrganizationMembershipsApi
  /** Images, videos and files attached to issues, pull requests and comments. */
  readonly attachments: GitHubAttachmentsApi
  repo(target: GitHubRepositoryTarget): GitHubRepositoryScope
  org(org: string): GitHubOrganizationScope
}

export interface GitHubRepositoryScope {
  readonly branches: RepositoryBranchesApi
  readonly commits: RepositoryCommitsApi
  readonly issues: RepositoryIssuesApi
  readonly pulls: RepositoryPullRequestsApi
  /** Stacks of dependent pull requests. */
  readonly stacks: RepositoryStacksApi
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
