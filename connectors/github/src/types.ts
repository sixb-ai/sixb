import type { OntologySource, Sixb } from "@sixb/core"
import type { GitHubClient } from "./client"
import type { GitHubIssue } from "./issues"
import type { GitHubRepository } from "./repos"

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

export interface GitHubUser {
  readonly login: string
  readonly id: number
  readonly node_id: string
  readonly type: string
  readonly html_url: string
  readonly url: string
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
