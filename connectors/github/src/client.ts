import type { RestClient } from "@sixb/connector-rest"
import { createIssuesClient, type IssuesClient } from "./issues"
import { createRepositoriesClient, type RepositoriesClient } from "./repos"
import type { GitHubConnectorOptions } from "./types"

export type GitHubClient = RepositoriesClient & IssuesClient

export function createGitHubClient(
  http: RestClient,
  options: GitHubConnectorOptions,
  apiBaseUrl: URL
): GitHubClient {
  const context = { http, apiBaseUrl }
  return {
    ...createRepositoriesClient(context),
    ...createIssuesClient(context, { owner: options.owner, repo: options.repo }),
  }
}
