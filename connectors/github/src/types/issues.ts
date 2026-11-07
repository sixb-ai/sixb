import type { GitHubBodyFormatOptions } from "./attachments"
import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"
import type { RepositoryIssueCommentsApi } from "./issue-comments"
import type { GitHubRepository, GitHubSortDirection } from "./repos"
import type { RepositoryIssueDependenciesApi, RepositorySubIssuesApi } from "./sub-issues"
import type { GitHubTimelineEvent, ListIssueTimelineOptions } from "./timeline"

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

interface ListAssignedIssuesOptions extends GitHubPaginationOptions, GitHubBodyFormatOptions {
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

export interface ListRepositoryIssuesOptions
  extends GitHubPaginationOptions,
    GitHubBodyFormatOptions {
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
  /** Six hex digits without `#`. */
  readonly color: string
  readonly description: string | null
  readonly default: boolean
  /** When the label was archived; `null` or absent while it is in use. */
  readonly archived_at?: string | null
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
  /** With `bodyFormat` `text` or `full`. */
  readonly body_text?: string | null
  /** With `bodyFormat` `html` or `full`. */
  readonly body_html?: string | null
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
  /** The issue this one is a sub-issue of, as an API URL. */
  readonly parent_issue_url?: string | null
  /** How many sub-issues it has and how many are closed. */
  readonly sub_issues_summary?: GitHubSubIssuesSummary
  /** How many issues block it and how many it blocks. */
  readonly issue_dependencies_summary?: GitHubIssueDependenciesSummary
}

export interface GitHubSubIssuesSummary {
  readonly total: number
  readonly completed: number
  readonly percent_completed: number
}

export interface GitHubIssueDependenciesSummary {
  /** Open issues blocking this one. */
  readonly blocked_by: number
  readonly total_blocked_by: number
  /** Open issues this one blocks. */
  readonly blocking: number
  readonly total_blocking: number
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
  /** An issue's sub-issues. */
  readonly subIssues: RepositorySubIssuesApi
  /** The issues blocking an issue, and those it blocks. */
  readonly dependencies: RepositoryIssueDependenciesApi
  /** List one page of this repository's issues. GitHub may include pull requests. */
  list(options?: ListRepositoryIssuesOptions): Promise<GitHubPage<GitHubIssue>>
  get(issueNumber: number, options?: GitHubBodyFormatOptions): Promise<GitHubIssue>
  create(input: CreateIssueInput): Promise<GitHubIssue>
  update(issueNumber: number, patch: UpdateIssueInput): Promise<GitHubIssue>
  /** List one page of an issue's or pull request's timeline: its comments and events, oldest first. */
  timeline(
    issueNumber: number,
    options?: ListIssueTimelineOptions
  ): Promise<GitHubPage<GitHubTimelineEvent>>
  /** The issue this one is a sub-issue of, or `null` when it has none or doesn't exist. */
  parent(
    issueNumber: number,
    options?: GitHubRequestOptions & GitHubBodyFormatOptions
  ): Promise<GitHubIssue | null>
}
