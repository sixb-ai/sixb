import type { GitHubPage, GitHubPaginationOptions, GitHubUser } from "./common"

export type GitHubRepositorySort = "created" | "updated" | "pushed" | "full_name"
export type GitHubSortDirection = "asc" | "desc"
export type GitHubRepositoryVisibility = "public" | "private" | "internal"
export type GitHubRepositoryVisibilityFilter = "all" | "public" | "private"
export type GitHubRepositoryAffiliation = "owner" | "collaborator" | "organization_member"
export type GitHubUserRepositoryType = "all" | "owner" | "public" | "private" | "member"
export type GitHubOrganizationRepositoryType =
  | "all"
  | "public"
  | "private"
  | "forks"
  | "sources"
  | "member"

interface ListRepositoriesBaseOptions extends GitHubPaginationOptions {
  readonly sort?: GitHubRepositorySort
  readonly direction?: GitHubSortDirection
}

export type ListAuthenticatedUserRepositoriesOptions = ListRepositoriesBaseOptions & {
  /** Only show repositories updated at or after this ISO 8601 timestamp. */
  readonly since?: string
  /** Only show repositories updated before this ISO 8601 timestamp. */
  readonly before?: string
} & (
    | {
        /** Cannot be combined with `visibility` or `affiliation`. */
        readonly type?: GitHubUserRepositoryType
        readonly visibility?: never
        readonly affiliation?: never
      }
    | {
        readonly type?: never
        readonly visibility?: GitHubRepositoryVisibilityFilter
        readonly affiliation?: readonly GitHubRepositoryAffiliation[]
      }
  )

export interface ListOrganizationRepositoriesOptions extends ListRepositoriesBaseOptions {
  readonly type?: GitHubOrganizationRepositoryType
}

export interface GitHubRepository {
  readonly id: number
  readonly node_id: string
  readonly name: string
  readonly full_name: string
  readonly private: boolean
  readonly html_url: string
  readonly description: string | null
  readonly fork: boolean
  readonly url: string
  readonly owner: GitHubUser
  readonly default_branch: string
  readonly open_issues_count: number
  readonly visibility: GitHubRepositoryVisibility
  readonly created_at: string
  readonly updated_at: string
  readonly pushed_at: string | null
}

export interface AuthenticatedUserRepositoriesApi {
  /** List one page of repositories for the authenticated user. */
  listForAuthenticatedUser(
    options?: ListAuthenticatedUserRepositoriesOptions
  ): Promise<GitHubPage<GitHubRepository>>
}

export interface OrganizationRepositoriesApi {
  /** List one page of repositories for this organization. */
  list(options?: ListOrganizationRepositoriesOptions): Promise<GitHubPage<GitHubRepository>>
}

export interface RepositoryApi {
  /** Get this repository. */
  get(): Promise<GitHubRepository>
}
