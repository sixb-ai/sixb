import type { OntologySource, Sixb } from "@sixb/core"

/**
 * Repository owner/name pair. When omitted on a call, the connector falls back
 * to the `owner`/`repo` configured on `github(options)`.
 */
export interface RepoTarget {
  readonly owner?: string
  readonly repo?: string
}

export interface GitHubConnectorOptions {
  /** GitHub token. A fine-grained personal access token is recommended. */
  readonly token: string
  /** Default repository owner (user or org) for issue operations. */
  readonly owner?: string
  /** Default repository name for issue operations. */
  readonly repo?: string
  /** API base URL. Override for GitHub Enterprise Server. */
  readonly baseUrl?: string
  /** Shared secret used to verify inbound webhook deliveries (X-Hub-Signature-256). */
  readonly webhookSecret?: string
  /** Invoked for each verified inbound webhook delivery, for any event type. */
  readonly onEvent?: GitHubEventHandler
}

export interface GitHubPaginationOptions {
  /** Results per page, 1-100 (defaults to GitHub's 30). */
  readonly pageSize?: number
  /** Opaque token returned by a previous page. */
  readonly pageToken?: string
}

export interface GitHubPage<T> {
  readonly items: readonly T[]
  readonly hasMore: boolean
  readonly nextPageToken?: string
  readonly previousPageToken?: string
}

export interface ListRepositoriesOptions extends GitHubPaginationOptions {
  /** List repositories for an organization instead of the authenticated user. */
  readonly org?: string
  readonly affiliation?: string
  readonly visibility?: "all" | "public" | "private"
  readonly sort?: "created" | "updated" | "pushed" | "full_name"
}

export interface ListIssuesOptions extends RepoTarget, GitHubPaginationOptions {
  readonly state?: "open" | "closed" | "all"
  readonly labels?: readonly string[]
  readonly assignee?: string
  /** Only issues updated at or after this ISO 8601 timestamp. */
  readonly since?: string
}

export interface CreateIssueInput extends RepoTarget {
  readonly title: string
  readonly body?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  readonly milestone?: number
}

export interface UpdateIssueInput extends RepoTarget {
  readonly title?: string
  readonly body?: string
  readonly state?: "open" | "closed"
  readonly stateReason?: "completed" | "not_planned" | "reopened" | null
  /** Replaces the full label set. */
  readonly labels?: readonly string[]
  /** Replaces the full assignee set. */
  readonly assignees?: readonly string[]
  readonly milestone?: number | null
}

export interface GitHubUser {
  readonly login: string
  readonly id: number
  readonly type: string
}

export interface GitHubLabel {
  readonly id: number
  readonly name: string
  readonly color: string
}

export interface GitHubRepository {
  readonly id: number
  readonly node_id: string
  readonly name: string
  readonly full_name: string
  readonly private: boolean
  readonly html_url: string
  readonly description: string | null
  readonly owner: GitHubUser
  readonly default_branch: string
  readonly open_issues_count: number
}

export interface GitHubIssue {
  readonly id: number
  readonly node_id: string
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly state: "open" | "closed"
  readonly state_reason: string | null
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

/**
 * Envelope for any inbound GitHub webhook delivery.
 *
 * `name` is the `X-GitHub-Event` header (e.g. "issues", "push", "issue_comment").
 * Narrow on `name`, then cast `payload` to the matching shape (e.g. `GitHubIssueEvent`).
 */
export interface GitHubWebhookEvent {
  readonly name: string
  /** The payload's `action` when present (e.g. "opened"). */
  readonly action?: string
  /** Unique delivery id from the `X-GitHub-Delivery` header. */
  readonly deliveryId: string
  readonly payload: Record<string, unknown>
}

/**
 * Context passed to `onEvent` for each verified inbound delivery.
 *
 * `sixb` is the live runtime — use it to upsert objects, append telemetry, or
 * request actions. `client()` lazily resolves the GitHub client so the handler
 * can call back (e.g. comment on or update the issue) only when it needs to.
 */
export interface GitHubEventContext {
  readonly event: GitHubWebhookEvent
  readonly sixb: Sixb<readonly OntologySource[]>
  client(): Promise<GitHubClient>
}

export type GitHubEventHandler = (context: GitHubEventContext) => Promise<void> | void

/** Payload delivered by the GitHub `issues` webhook event. */
export interface GitHubIssueEvent {
  readonly action: string
  readonly issue: GitHubIssue
  readonly repository: GitHubRepository
  readonly sender: GitHubUser
}

export interface GitHubClient {
  /** List one page of repositories for the authenticated user (or an org). */
  listRepositories(options?: ListRepositoriesOptions): Promise<GitHubPage<GitHubRepository>>
  /** Iterate repositories for the authenticated user (or an org), following GitHub pagination. */
  iterRepositories(options?: ListRepositoriesOptions): AsyncIterable<GitHubRepository>
  /** List one page of a repository's issues, with pull requests filtered out. */
  listIssues(options?: ListIssuesOptions): Promise<GitHubPage<GitHubIssue>>
  /** Iterate a repository's issues, following GitHub pagination. */
  iterIssues(options?: ListIssuesOptions): AsyncIterable<GitHubIssue>
  createIssue(input: CreateIssueInput): Promise<GitHubIssue>
  updateIssue(issueNumber: number, patch: UpdateIssueInput): Promise<GitHubIssue>
  /** Closes the issue. GitHub's REST API cannot delete issues, only close them. */
  deleteIssue(issueNumber: number, target?: RepoTarget): Promise<GitHubIssue>
}
