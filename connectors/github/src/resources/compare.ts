import type { GitHubHttpContext } from "../http"
import { readJson, refPath, repositoryPath } from "../http"
import type { GitHubRepositoryTarget } from "../types/common"
import type {
  CompareOptions,
  CompareRefs,
  GitHubCompare,
  RepositoryCompareApi,
} from "../types/compare"

export function createRepositoryCompareApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryCompareApi {
  return {
    async compare(refs: CompareRefs, options?: CompareOptions): Promise<GitHubCompare> {
      // GitHub reads the two refs out of one path segment, `base...head`, so each is written as its
      // own segments and the two are joined with the diff's own dots.
      const separator = options?.diff === "two-dot" ? ".." : "..."
      const basehead = `${refPath(refs.base, "base")}${separator}${refPath(refs.head, "head")}`
      return readJson<GitHubCompare>(
        await context.http.get(`${repositoryPath(target)}/compare/${basehead}`, {
          signal: options?.signal,
        })
      )
    },
  }
}
