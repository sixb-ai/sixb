import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  pathPart,
  readJson,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubPage, GitHubRepositoryTarget } from "../types/common"
import type {
  AuthenticatedUserRepositoriesApi,
  GitHubRepository,
  ListAuthenticatedUserRepositoriesOptions,
  ListOrganizationRepositoriesOptions,
  OrganizationRepositoriesApi,
  RepositoryApi,
} from "../types/repos"

export function createAuthenticatedUserRepositoriesApi(
  context: GitHubHttpContext
): AuthenticatedUserRepositoriesApi {
  return {
    async listForAuthenticatedUser(
      options?: ListAuthenticatedUserRepositoriesOptions
    ): Promise<GitHubPage<GitHubRepository>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      applyRepositoryListBaseParams(params, options)
      if (options?.type) params.set("type", options.type)
      if (options?.visibility) params.set("visibility", options.visibility)
      if (options?.affiliation?.length) params.set("affiliation", options.affiliation.join(","))
      if (options?.since) params.set("since", options.since)
      if (options?.before) params.set("before", options.before)
      return readPage<GitHubRepository>(
        await context.http.get(resolvePagePath(withQuery("/user/repos", params), options)),
        context.apiBaseUrl
      )
    },
  }
}

export function createOrganizationRepositoriesApi(
  context: GitHubHttpContext,
  org: string
): OrganizationRepositoriesApi {
  const orgPath = pathPart(org, "org")
  return {
    async list(
      options?: ListOrganizationRepositoriesOptions
    ): Promise<GitHubPage<GitHubRepository>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      applyRepositoryListBaseParams(params, options)
      if (options?.type) params.set("type", options.type)
      const path = withQuery(`/orgs/${orgPath}/repos`, params)
      return readPage<GitHubRepository>(
        await context.http.get(resolvePagePath(path, options)),
        context.apiBaseUrl
      )
    },
  }
}

export function createRepositoryApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryApi {
  const repoPath = repositoryPath(target)
  return {
    async get(): Promise<GitHubRepository> {
      return readJson<GitHubRepository>(await context.http.get(repoPath))
    },
  }
}

function applyRepositoryListBaseParams(
  params: URLSearchParams,
  options?: { readonly sort?: string; readonly direction?: string }
): void {
  if (options?.sort) params.set("sort", options.sort)
  if (options?.direction) params.set("direction", options.direction)
}
