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
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"
import type { GitHubLabel } from "../types/issues"
import type {
  CreateLabelInput,
  ListLabelsOptions,
  RepositoryLabelsApi,
  UpdateLabelInput,
} from "../types/labels"

export function createRepositoryLabelsApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryLabelsApi {
  const path = `${repositoryPath(target)}/labels`
  // One path segment, so names with spaces or `/` reach the right label.
  const labelPath = (name: string) => `${path}/${pathPart(name, "name")}`

  return {
    async list(options?: ListLabelsOptions): Promise<GitHubPage<GitHubLabel>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      return readPage<GitHubLabel>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async get(name: string, options?: GitHubRequestOptions): Promise<GitHubLabel> {
      return readJson<GitHubLabel>(
        await context.http.get(labelPath(name), { signal: options?.signal })
      )
    },

    async create(input: CreateLabelInput, options?: GitHubRequestOptions): Promise<GitHubLabel> {
      assertNonEmpty(input.name, "name")
      return readJson<GitHubLabel>(
        await context.http.post(
          path,
          { name: input.name, color: labelColor(input.color), description: input.description },
          { signal: options?.signal }
        )
      )
    },

    async update(
      name: string,
      patch: UpdateLabelInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubLabel> {
      if (patch.newName !== undefined) assertNonEmpty(patch.newName, "newName")
      return readJson<GitHubLabel>(
        await context.http.request(labelPath(name), {
          method: "PATCH",
          body: {
            new_name: patch.newName,
            color: patch.color === undefined ? undefined : labelColor(patch.color),
            description: patch.description,
          },
          signal: options?.signal,
        })
      )
    },

    async delete(name: string, options?: GitHubRequestOptions): Promise<void> {
      return readNoContent(
        await context.http.request(labelPath(name), { method: "DELETE", signal: options?.signal })
      )
    },
  }
}

/** GitHub takes six hex digits without `#`; a leading `#` is dropped. */
function labelColor(value: string): string {
  const color = value.trim().replace(/^#/, "")
  if (!/^[0-9a-f]{6}$/i.test(color)) {
    throw new Error("[SixbGitHub] color must be six hex digits, such as d73a4a.")
  }
  return color.toLowerCase()
}
