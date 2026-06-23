import type { GitHubPage, GitHubPaginationOptions, GitHubUser } from "./common"
import type { RepositoryIssueCommentsApi } from "./issue-comments"
import type { GitHubRepository, GitHubSortDirection } from "./repos"

export type GitHubIssueFilter =
  | "assigned"
  | "created"
  | "mentioned"
  | "subscribed"
  | "repos"
  | "all"
export type GitHubIssueState = "open" | "closed" | "all"
export type GitHubIssueSort = "created" | "updated" | "comments"
export type GitHubIssueStateReason = "completed" | "not_planned" | "duplicate" | "reopened" | null

interface ListAssignedIssuesOptions extends GitHubPaginationOptions {
  readonly filter?: GitHubIssueFilter
  readonly state?: GitHubIssueState
  readonly labels?: readonly string[]
  readonly sort?: GitHubIssueSort
  readonly direction?: GitHubSortDirection
  /** Only show issues updated at or after this ISO 8601 timestamp. */
  readonly since?: string
}

export interface ListAuthenticatedUserIssuesOptions extends ListAssignedIssuesOptions {
  readonly collab?: boolean
  readonly orgs?: boolean
  readonly owned?: boolean
  readonly pulls?: boolean
}

export interface ListOrganizationIssuesOptions extends ListAssignedIssuesOptions {
  readonly type?: string
}

export interface ListRepositoryIssuesOptions extends GitHubPaginationOptions {
  readonly milestone?: string | number
  readonly state?: GitHubIssueState
  readonly assignee?: string
  readonly type?: string
  readonly creator?: string
  readonly mentioned?: string
  readonly issueFieldValues?: string
  readonly labels?: readonly string[]
  readonly sort?: GitHubIssueSort
  readonly direction?: GitHubSortDirection
  /** Only show issues updated at or after this ISO 8601 timestamp. */
  readonly since?: string
}

export type GitHubIssueFieldValue = string | number | readonly (string | number)[]

export interface GitHubIssueFieldValueInput {
  readonly fieldId: number
  readonly value: GitHubIssueFieldValue
}

export interface CreateIssueInput {
  readonly title: string | number
  readonly body?: string
  readonly milestone?: number | string | null
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  readonly issueFieldValues?: readonly GitHubIssueFieldValueInput[]
  readonly type?: string | null
}

export interface UpdateIssueInput {
  readonly title?: string | number | null
  readonly body?: string | null
  readonly state?: "open" | "closed"
  readonly stateReason?: GitHubIssueStateReason
  readonly milestone?: number | string | null
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  readonly issueFieldValues?: readonly GitHubIssueFieldValueInput[]
  readonly type?: string | null
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

export interface GitHubMilestone {
  readonly id: number
  readonly node_id: string
  readonly number: number
  readonly state: "open" | "closed"
  readonly title: string
  readonly description: string | null
  readonly creator: GitHubUser
  readonly open_issues: number
  readonly closed_issues: number
  readonly created_at: string
  readonly updated_at: string
  readonly closed_at: string | null
  readonly due_on: string | null
}

export interface GitHubPullRequestIssueRef {
  readonly url: string
  readonly html_url: string
  readonly diff_url: string
  readonly patch_url: string
}

export interface GitHubIssue {
  readonly id: number
  readonly node_id: string
  readonly url: string
  readonly repository_url: string
  readonly labels_url: string
  readonly comments_url: string
  readonly events_url: string
  readonly html_url: string
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly user: GitHubUser
  readonly labels: readonly GitHubLabel[]
  readonly state: "open" | "closed"
  readonly state_reason: GitHubIssueStateReason
  readonly assignee: GitHubUser | null
  readonly assignees: readonly GitHubUser[]
  readonly milestone: GitHubMilestone | null
  readonly locked: boolean
  readonly active_lock_reason: string | null
  readonly comments: number
  readonly closed_at: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly closed_by?: GitHubUser | null
  readonly author_association: string
  readonly repository?: GitHubRepository
  /** Present only when the entry is actually a pull request. */
  readonly pull_request?: GitHubPullRequestIssueRef
}

export interface AuthenticatedUserIssuesApi {
  /** List one page of issues assigned to the authenticated user. */
  listForAuthenticatedUser(
    options?: ListAuthenticatedUserIssuesOptions
  ): Promise<GitHubPage<GitHubIssue>>
}

export interface OrganizationIssuesApi {
  /** List one page of organization issues assigned to the authenticated user. */
  listForAuthenticatedUser(
    options?: ListOrganizationIssuesOptions
  ): Promise<GitHubPage<GitHubIssue>>
}

export interface RepositoryIssuesApi {
  readonly comments: RepositoryIssueCommentsApi
  /** List one page of this repository's issues. GitHub may include pull requests. */
  list(options?: ListRepositoryIssuesOptions): Promise<GitHubPage<GitHubIssue>>
  get(issueNumber: number): Promise<GitHubIssue>
  create(input: CreateIssueInput): Promise<GitHubIssue>
  update(issueNumber: number, patch: UpdateIssueInput): Promise<GitHubIssue>
}
