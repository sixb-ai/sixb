import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  bodyFormatHeaders,
  pathId,
  pathPart,
  readJson,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubBodyFormatOptions } from "../types/attachments"
import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRepositoryTarget,
  GitHubRequestOptions,
} from "../types/common"
import type {
  AuthenticatedUserIssuesApi,
  CreateIssueInput,
  GitHubIssue,
  GitHubIssueFilter,
  GitHubIssueSort,
  GitHubIssueState,
  ListAuthenticatedUserIssuesOptions,
  ListOrganizationIssuesOptions,
  ListRepositoryIssuesOptions,
  OrganizationIssuesApi,
  RepositoryIssuesApi,
  UpdateIssueInput,
} from "../types/issues"
import type { GitHubSortDirection } from "../types/repos"
import type { GitHubTimelineEvent, ListIssueTimelineOptions } from "../types/timeline"
import { createRepositoryIssueCommentsApi } from "./issue-comments"
import { createRepositoryIssueDependenciesApi, createRepositorySubIssuesApi } from "./sub-issues"

export function createAuthenticatedUserIssuesApi(
  context: GitHubHttpContext
): AuthenticatedUserIssuesApi {
  return {
    listForAuthenticatedUser: (options) =>
      listIssues(context, "/issues", options, applyAssignedIssueParams),
  }
}

export function createOrganizationIssuesApi(
  context: GitHubHttpContext,
  org: string
): OrganizationIssuesApi {
  const path = `/orgs/${pathPart(org, "org")}/issues`
  return {
    listForAuthenticatedUser: (options) =>
      listIssues(context, path, options, applyOrganizationIssueParams),
  }
}

export function createRepositoryIssuesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryIssuesApi {
  const path = `${repositoryPath(target)}/issues`
  return {
    comments: createRepositoryIssueCommentsApi(context, target),
    subIssues: createRepositorySubIssuesApi(context, target),
    dependencies: createRepositoryIssueDependenciesApi(context, target),

    list: (options) => listIssues(context, path, options, applyRepositoryIssueParams),

    async get(issueNumber: number, options?: GitHubBodyFormatOptions): Promise<GitHubIssue> {
      return readJson<GitHubIssue>(
        await context.http.get(issuePath(path, issueNumber), {
          headers: bodyFormatHeaders(options?.bodyFormat),
        })
      )
    },

    async create(input: CreateIssueInput): Promise<GitHubIssue> {
      return readJson<GitHubIssue>(await context.http.post(path, issueBody(input)))
    },

    async timeline(
      issueNumber: number,
      options?: ListIssueTimelineOptions
    ): Promise<GitHubPage<GitHubTimelineEvent>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      const timelinePath = withQuery(`${issuePath(path, issueNumber)}/timeline`, params)
      return readPage<GitHubTimelineEvent>(
        await context.http.get(resolvePagePath(timelinePath, options), {
          headers: bodyFormatHeaders(options?.bodyFormat),
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async parent(
      issueNumber: number,
      options?: GitHubRequestOptions & GitHubBodyFormatOptions
    ): Promise<GitHubIssue | null> {
      const response = await context.http.get(`${issuePath(path, issueNumber)}/parent`, {
        headers: bodyFormatHeaders(options?.bodyFormat),
        signal: options?.signal,
      })
      // GitHub answers 404 for an issue without a parent, the same as for a missing issue.
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      return readJson<GitHubIssue>(response)
    },

    async update(issueNumber: number, patch: UpdateIssueInput): Promise<GitHubIssue> {
      return readJson<GitHubIssue>(
        await context.http.request(issuePath(path, issueNumber), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(issueBody(patch)),
        })
      )
    },
  }
}

async function listIssues<TOptions extends GitHubPaginationOptions & GitHubBodyFormatOptions>(
  context: GitHubHttpContext,
  path: string,
  options: TOptions | undefined,
  applyParams: (params: URLSearchParams, options: TOptions | undefined) => void
): Promise<GitHubPage<GitHubIssue>> {
  const params = new URLSearchParams()
  applyPaging(params, options)
  applyParams(params, options)
  return readPage<GitHubIssue>(
    await context.http.get(resolvePagePath(withQuery(path, params), options), {
      headers: bodyFormatHeaders(options?.bodyFormat),
    }),
    context.apiBaseUrl
  )
}

function applyAssignedIssueParams(
  params: URLSearchParams,
  options?: ListAuthenticatedUserIssuesOptions
): void {
  applyIssueListBaseParams(params, options)
  appendBoolean(params, "collab", options?.collab)
  appendBoolean(params, "orgs", options?.orgs)
  appendBoolean(params, "owned", options?.owned)
  appendBoolean(params, "pulls", options?.pulls)
}

function applyOrganizationIssueParams(
  params: URLSearchParams,
  options?: ListOrganizationIssuesOptions
): void {
  applyIssueListBaseParams(params, options)
  if (options?.type) params.set("type", options.type)
}

function applyRepositoryIssueParams(
  params: URLSearchParams,
  options?: ListRepositoryIssuesOptions
): void {
  if (options?.milestone !== undefined) params.set("milestone", String(options.milestone))
  if (options?.assignee) params.set("assignee", options.assignee)
  if (options?.type) params.set("type", options.type)
  if (options?.creator) params.set("creator", options.creator)
  if (options?.mentioned) params.set("mentioned", options.mentioned)
  if (options?.issueFieldValues) params.set("issue_field_values", options.issueFieldValues)
  applyIssueListBaseParams(params, options)
}

function applyIssueListBaseParams(
  params: URLSearchParams,
  options?: {
    readonly filter?: GitHubIssueFilter
    readonly state?: GitHubIssueState
    readonly labels?: readonly string[]
    readonly sort?: GitHubIssueSort
    readonly direction?: GitHubSortDirection
    readonly since?: string
  }
): void {
  if (options?.filter) params.set("filter", options.filter)
  if (options?.state) params.set("state", options.state)
  if (options?.labels?.length) params.set("labels", options.labels.join(","))
  if (options?.sort) params.set("sort", options.sort)
  if (options?.direction) params.set("direction", options.direction)
  if (options?.since) params.set("since", options.since)
}

function appendBoolean(params: URLSearchParams, key: string, value: boolean | undefined): void {
  if (value !== undefined) params.set(key, String(value))
}

function issueBody(input: CreateIssueInput | UpdateIssueInput): Record<string, unknown> {
  return {
    title: input.title,
    body: input.body,
    state: "state" in input ? input.state : undefined,
    state_reason: "stateReason" in input ? input.stateReason : undefined,
    milestone: input.milestone,
    labels: input.labels,
    assignees: input.assignees,
    issue_field_values: input.issueFieldValues?.map(({ fieldId, value }) => ({
      field_id: fieldId,
      value,
    })),
    type: input.type,
  }
}

function issuePath(path: string, issueNumber: number): string {
  return `${path}/${pathId(issueNumber, "issueNumber")}`
}
