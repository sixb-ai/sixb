import type { RepositoryActionsApi } from "./actions"
import type { RepositoryAssigneesApi } from "./assignees"
import type { GitHubAttachmentsApi } from "./attachments"
import type { RepositoryBranchesApi } from "./branches"
import type { RepositoryChecksApi } from "./checks"
import type { RepositoryCommitsApi } from "./commits"
import type { GitHubRepositoryTarget } from "./common"
import type { CompareOptions, CompareRefs, GitHubCompare } from "./compare"
import type { RepositoryContentsApi } from "./contents"
import type {
  AuthenticatedUserIssuesApi,
  OrganizationIssuesApi,
  RepositoryIssuesApi,
} from "./issues"
import type { RepositoryLabelsApi } from "./labels"
import type {
  AuthenticatedUserOrganizationMembershipsApi,
  OrganizationInvitationsApi,
  OrganizationMembersApi,
  OrganizationOutsideCollaboratorsApi,
} from "./members"
import type { RepositoryMilestonesApi } from "./milestones"
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
  /** Workflows, their runs and jobs, logs and artifacts. Reading needs `Actions: read`. */
  readonly actions: RepositoryActionsApi
  readonly assignees: RepositoryAssigneesApi
  readonly branches: RepositoryBranchesApi
  /** A commit's check runs and its combined commit status. */
  readonly checks: RepositoryChecksApi
  readonly commits: RepositoryCommitsApi
  /** A file, a symlink, a submodule or a directory at a branch, tag or commit. */
  readonly contents: RepositoryContentsApi
  /** Compare two refs: the commits between them and the files they change. */
  compare(refs: CompareRefs, options?: CompareOptions): Promise<GitHubCompare>
  readonly issues: RepositoryIssuesApi
  readonly labels: RepositoryLabelsApi
  readonly milestones: RepositoryMilestonesApi
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
