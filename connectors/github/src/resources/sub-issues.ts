import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  bodyFormatHeaders,
  pathId,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubPage, GitHubRepositoryTarget } from "../types/common"
import type { GitHubIssue } from "../types/issues"
import type {
  ListRelatedIssuesOptions,
  RepositoryIssueDependenciesApi,
  RepositorySubIssuesApi,
} from "../types/sub-issues"

export function createRepositorySubIssuesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositorySubIssuesApi {
  const issues = `${repositoryPath(target)}/issues`
  return {
    list: async (issueNumber, options) =>
      listRelatedIssues(
        context,
        `${issues}/${pathId(issueNumber, "issueNumber")}/sub_issues`,
        options
      ),
  }
}

export function createRepositoryIssueDependenciesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryIssueDependenciesApi {
  const dependencies = (issueNumber: number) =>
    `${repositoryPath(target)}/issues/${pathId(issueNumber, "issueNumber")}/dependencies`
  return {
    blockedBy: async (issueNumber, options) =>
      listRelatedIssues(context, `${dependencies(issueNumber)}/blocked_by`, options),
    blocking: async (issueNumber, options) =>
      listRelatedIssues(context, `${dependencies(issueNumber)}/blocking`, options),
  }
}

async function listRelatedIssues(
  context: GitHubHttpContext,
  path: string,
  options: ListRelatedIssuesOptions | undefined
): Promise<GitHubPage<GitHubIssue>> {
  const params = new URLSearchParams()
  applyPaging(params, options)
  return readPage<GitHubIssue>(
    await context.http.get(resolvePagePath(withQuery(path, params), options), {
      headers: bodyFormatHeaders(options?.bodyFormat),
      signal: options?.signal,
    }),
    context.apiBaseUrl
  )
}
