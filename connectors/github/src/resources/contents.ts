import type { GitHubHttpContext } from "../http"
import { readDownload, readJson, refPath, repositoryPath, withQuery } from "../http"
import type { GitHubRepositoryTarget } from "../types/common"
import type { GetContentsOptions, GitHubContent, RepositoryContentsApi } from "../types/contents"

/** What GitHub's raw media type returns a file's bytes as. */
const RAW_CONTENT_ACCEPT = "application/vnd.github.raw+json"

export function createRepositoryContentsApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryContentsApi {
  const contents = `${repositoryPath(target)}/contents`
  // The root is the contents path itself: an empty path is the directory listing, not a request.
  const pathFor = (path: string | undefined) =>
    path === undefined || path.trim() === "" ? contents : `${contents}/${refPath(path, "path")}`

  return {
    async get(path?: string, options?: GetContentsOptions): Promise<GitHubContent> {
      const params = new URLSearchParams()
      if (options?.ref) params.set("ref", options.ref)
      return readJson<GitHubContent>(
        await context.http.get(withQuery(pathFor(path), params), { signal: options?.signal })
      )
    },

    async raw(path: string, options?: GetContentsOptions): Promise<Response> {
      const params = new URLSearchParams()
      if (options?.ref) params.set("ref", options.ref)
      return readDownload(context, withQuery(pathFor(path), params), {
        accept: RAW_CONTENT_ACCEPT,
        signal: options?.signal,
      })
    },
  }
}
