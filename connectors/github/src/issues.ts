import type { GitHubHttpContext } from "./http"
import { applyPaging, readJson, readPage, resolvePagePath, withQuery } from "./http"
import type { GitHubSortDirection } from "./repos"
import type { GitHubPage, GitHubPaginationOptions, GitHubUser, RepoTarget } from "./types"

export interface ListRepositoryIssuesOptions extends RepoTarget, GitHubPaginationOptions {
  readonly state?: "open" | "closed" | "all"
  readonly labels?: readonly string[]
  readonly assignee?: string
  readonly sort?: "created" | "updated" | "comments"
  readonly direction?: GitHubSortDirection
  /** Only issues updated at or after this ISO 8601 timestamp. */
  readonly since?: string
}

export interface CreateIssueInput extends RepoTarget {
  readonly title: string | number
  readonly body?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  readonly milestone?: number | string | null
}

export interface UpdateIssueInput extends RepoTarget {
  readonly title?: string | number | null
  readonly body?: string | null
  readonly state?: "open" | "closed"
  readonly stateReason?: "completed" | "not_planned" | "duplicate" | "reopened" | null
  /** Replaces the full label set. */
  readonly labels?: readonly string[]
  /** Replaces the full assignee set. */
  readonly assignees?: readonly string[]
  readonly milestone?: number | string | null
}

export interface GitHubLabel {
  readonly id: number
  readonly node_id: string
  readonly url: string
  readonly name: string
  readonly color: string
  readonly description: string | null
  readonly default: boolean
}

export type GitHubIssueStateReason = "completed" | "not_planned" | "duplicate" | "reopened" | null

export interface GitHubIssue {
  readonly id: number
  readonly node_id: string
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly state: "open" | "closed"
  readonly state_reason: GitHubIssueStateReason
  readonly html_url: string
  readonly labels: readonly GitHubLabel[]
  readonly assignees: readonly GitHubUser[]
  readonly user: GitHubUser
  readonly comments: number
  readonly created_at: string
  readonly updated_at: string
  readonly closed_at: string | null
  /** Present only when the entry is actually a pull request. */
  readonly pull_request?: unknown
}

export interface IssuesClient {
  /** List one page of a repository's issues. GitHub may include pull requests. */
  listRepositoryIssues(options?: ListRepositoryIssuesOptions): Promise<GitHubPage<GitHubIssue>>
  createIssue(input: CreateIssueInput): Promise<GitHubIssue>
  updateIssue(issueNumber: number, patch: UpdateIssueInput): Promise<GitHubIssue>
}

export interface IssuesClientOptions {
  readonly owner?: string
  readonly repo?: string
}

export function createIssuesClient(
  context: GitHubHttpContext,
  options: IssuesClientOptions
): IssuesClient {
  const resolveRepo = (target?: RepoTarget): { owner: string; repo: string } => {
    const owner = target?.owner ?? options.owner
    const repo = target?.repo ?? options.repo
    if (!owner || !repo) {
      throw new Error(
        "[SixbGitHub] owner and repo are required — pass them in the call or set them on the connector."
      )
    }
    return { owner, repo }
  }

  const updateIssue = async (
    issueNumber: number,
    patch: UpdateIssueInput
  ): Promise<GitHubIssue> => {
    const { owner, repo } = resolveRepo(patch)
    const response = await context.http.request(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: patch.title,
        body: patch.body,
        state: patch.state,
        state_reason: patch.stateReason,
        labels: patch.labels,
        assignees: patch.assignees,
        milestone: patch.milestone,
      }),
    })
    return readJson<GitHubIssue>(response)
  }

  return {
    async listRepositoryIssues(
      listOptions?: ListRepositoryIssuesOptions
    ): Promise<GitHubPage<GitHubIssue>> {
      const { owner, repo } = resolveRepo(listOptions)
      const params = new URLSearchParams({ state: listOptions?.state ?? "open" })
      applyPaging(params, listOptions)
      if (listOptions?.labels?.length) params.set("labels", listOptions.labels.join(","))
      if (listOptions?.assignee) params.set("assignee", listOptions.assignee)
      if (listOptions?.sort) params.set("sort", listOptions.sort)
      if (listOptions?.direction) params.set("direction", listOptions.direction)
      if (listOptions?.since) params.set("since", listOptions.since)
      const path = withQuery(`/repos/${owner}/${repo}/issues`, params)
      const page = await readPage<GitHubIssue>(
        await context.http.get(resolvePagePath(path, listOptions)),
        context.apiBaseUrl
      )
      return page
    },

    async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
      const { owner, repo } = resolveRepo(input)
      const response = await context.http.post(`/repos/${owner}/${repo}/issues`, {
        title: input.title,
        body: input.body,
        labels: input.labels,
        assignees: input.assignees,
        milestone: input.milestone,
      })
      return readJson<GitHubIssue>(response)
    },

    updateIssue,
  }
}
