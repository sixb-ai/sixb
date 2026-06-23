import type { RestClient } from "@sixb/connector-rest"
import {
  createAuthenticatedUserIssuesApi,
  createOrganizationIssuesApi,
  createRepositoryIssuesApi,
} from "./resources/issues"
import {
  createAuthenticatedUserRepositoriesApi,
  createOrganizationRepositoriesApi,
  createRepositoryApi,
} from "./resources/repos"
import type { GitHubClient } from "./types/client"

export function createGitHubClient(http: RestClient, apiBaseUrl: URL): GitHubClient {
  const context = { http, apiBaseUrl }
  return {
    repos: createAuthenticatedUserRepositoriesApi(context),
    issues: createAuthenticatedUserIssuesApi(context),
    repo: (target) => ({
      ...createRepositoryApi(context, target),
      issues: createRepositoryIssuesApi(context, target),
    }),
    org: (org) => ({
      repos: createOrganizationRepositoriesApi(context, org),
      issues: createOrganizationIssuesApi(context, org),
    }),
  }
}
