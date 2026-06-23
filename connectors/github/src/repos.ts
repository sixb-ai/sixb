import type { GitHubHttpContext } from "./http"
import { applyPaging, assertNonEmpty, readPage, resolvePagePath, withQuery } from "./http"
import type { GitHubPage, GitHubPaginationOptions, GitHubUser } from "./types"

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

export type ListRepositoriesForAuthenticatedUserOptions = ListRepositoriesBaseOptions & {
  readonly org?: never
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
  /** List repositories for an organization instead of the authenticated user. */
  readonly org: string
  readonly type?: GitHubOrganizationRepositoryType
  readonly visibility?: never
  readonly affiliation?: never
  readonly since?: never
  readonly before?: never
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

export interface RepositoriesClient {
  /** List one page of repositories for the authenticated user. */
  listRepositoriesForAuthenticatedUser(
    options?: ListRepositoriesForAuthenticatedUserOptions
  ): Promise<GitHubPage<GitHubRepository>>
  /** List one page of repositories for an organization. */
  listOrganizationRepositories(
    options: ListOrganizationRepositoriesOptions
  ): Promise<GitHubPage<GitHubRepository>>
}

export function createRepositoriesClient(context: GitHubHttpContext): RepositoriesClient {
  return {
    async listRepositoriesForAuthenticatedUser(
      listOptions?: ListRepositoriesForAuthenticatedUserOptions
    ): Promise<GitHubPage<GitHubRepository>> {
      const params = new URLSearchParams()
      applyPaging(params, listOptions)
      applyRepositoryListBaseParams(params, listOptions)
      if (listOptions?.type) params.set("type", listOptions.type)
      if (listOptions?.visibility) params.set("visibility", listOptions.visibility)
      if (listOptions?.affiliation?.length) {
        params.set("affiliation", listOptions.affiliation.join(","))
      }
      if (listOptions?.since) params.set("since", listOptions.since)
      if (listOptions?.before) params.set("before", listOptions.before)
      return readPage<GitHubRepository>(
        await context.http.get(resolvePagePath(withQuery("/user/repos", params), listOptions)),
        context.apiBaseUrl
      )
    },

    async listOrganizationRepositories(
      listOptions: ListOrganizationRepositoriesOptions
    ): Promise<GitHubPage<GitHubRepository>> {
      assertNonEmpty(listOptions.org, "org")
      const params = new URLSearchParams()
      applyPaging(params, listOptions)
      applyRepositoryListBaseParams(params, listOptions)
      if (listOptions.type) params.set("type", listOptions.type)
      const path = withQuery(`/orgs/${listOptions.org}/repos`, params)
      return readPage<GitHubRepository>(
        await context.http.get(resolvePagePath(path, listOptions)),
        context.apiBaseUrl
      )
    },
  }
}

function applyRepositoryListBaseParams(
  params: URLSearchParams,
  options?: { readonly sort?: string; readonly direction?: string }
): void {
  if (!options) {
    return
  }

  if (options.sort) params.set("sort", options.sort)
  if (options.direction) params.set("direction", options.direction)
}
