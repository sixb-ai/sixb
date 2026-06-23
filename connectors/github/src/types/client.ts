import type { GitHubRepositoryTarget } from "./common"
import type {
  AuthenticatedUserIssuesApi,
  OrganizationIssuesApi,
  RepositoryIssuesApi,
} from "./issues"
import type {
  AuthenticatedUserRepositoriesApi,
  GitHubRepository,
  OrganizationRepositoriesApi,
} from "./repos"

export interface GitHubClient {
  readonly repos: AuthenticatedUserRepositoriesApi
  readonly issues: AuthenticatedUserIssuesApi
  repo(target: GitHubRepositoryTarget): GitHubRepositoryScope
  org(org: string): GitHubOrganizationScope
}

export interface GitHubRepositoryScope {
  readonly issues: RepositoryIssuesApi
  get(): Promise<GitHubRepository>
}

export interface GitHubOrganizationScope {
  readonly repos: OrganizationRepositoriesApi
  readonly issues: OrganizationIssuesApi
}
