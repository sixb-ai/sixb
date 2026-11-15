import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  assertNonEmpty,
  pathPart,
  readJson,
  readNoContent,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type {
  CreateBranchInput,
  GitHubBranch,
  GitHubBranchDetail,
  GitHubGitRef,
  ListBranchesOptions,
  RepositoryBranchesApi,
} from "../types/branches"
import type { GitHubCommit } from "../types/commits"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"

/** Characters Git refuses in a ref name, besides the paths that are checked separately. */
const REF_FORBIDDEN_CHARACTERS = ["~", "^", ":", "?", "*", "[", "\\", "|"]

export function createRepositoryBranchesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryBranchesApi {
  const path = `${repositoryPath(target)}/branches`
  const repo = repositoryPath(target)

  return {
    async list(options?: ListBranchesOptions): Promise<GitHubPage<GitHubBranch>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.protected !== undefined) params.set("protected", String(options.protected))
      return readPage<GitHubBranch>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async get(branch: string, options?: GitHubRequestOptions): Promise<GitHubBranchDetail> {
      return readJson<GitHubBranchDetail>(
        await context.http.get(`${path}/${pathPart(branch, "branch")}`, {
          signal: options?.signal,
        })
      )
    },

    // GitHub creates a ref from a commit SHA, so a branch or tag name is resolved first: a caller
    // naming the branch it forks from should not have to look the commit up itself.
    async create(input: CreateBranchInput, options?: GitHubRequestOptions): Promise<GitHubGitRef> {
      const ref = `refs/heads/${assertBranchName(input.name)}`
      const from = pathPart(input.from, "from")
      const commit = await readJson<GitHubCommit>(
        await context.http.get(`${repo}/commits/${from}`, { signal: options?.signal })
      )
      return readJson<GitHubGitRef>(
        await context.http.post(
          `${repo}/git/refs`,
          { ref, sha: commit.sha },
          { signal: options?.signal }
        )
      )
    },

    async delete(branch: string, options?: GitHubRequestOptions): Promise<void> {
      // The name is a path of its own segments, so a slash in it stays a slash.
      const ref = ["heads", ...assertBranchName(branch).split("/")]
        .map((segment) => pathPart(segment, "branch"))
        .join("/")
      return readNoContent(
        await context.http.request(`${repo}/git/refs/${ref}`, {
          method: "DELETE",
          signal: options?.signal,
        })
      )
    },
  }
}

/**
 * Refuse a name Git would, before the request: GitHub answers a bad ref with a 422 that names
 * nothing a caller can fix.
 */
function assertBranchName(name: string): string {
  assertNonEmpty(name, "name")
  if (name.startsWith("refs/")) {
    throw new Error(
      "[SixbGitHub] name is a branch name, not a ref: pass feature/login, not refs/heads/feature/login."
    )
  }
  const invalid =
    name.startsWith("/") ||
    name.startsWith("-") ||
    name.endsWith("/") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("@{") ||
    /\s/.test(name) ||
    REF_FORBIDDEN_CHARACTERS.some((character) => name.includes(character))
  if (invalid) {
    throw new Error(
      "[SixbGitHub] name is not a valid branch name: Git refuses whitespace, .., @{, a leading / or -, a trailing / or .lock, and any of ~ ^ : ? * [ \\ |."
    )
  }
  return name
}
