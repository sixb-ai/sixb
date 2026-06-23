import type {
  WebhookEventMap as GitHubWebhookEventMap,
  WebhookEventName as GitHubWebhookEventName,
} from "@octokit/webhooks-types"
import type { OntologySource, Sixb } from "@sixb/core"
import type { GitHubClient } from "./client"

export type { GitHubWebhookEventMap, GitHubWebhookEventName }

export type GitHubWebhookPayload<Name extends GitHubWebhookEventName = GitHubWebhookEventName> =
  GitHubWebhookEventMap[Name]

type GitHubWebhookAction<Name extends GitHubWebhookEventName> =
  GitHubWebhookPayload<Name> extends { readonly action: infer Action } ? Action : never

/**
 * Envelope for any inbound GitHub webhook delivery.
 *
 * `name` is the `X-GitHub-Event` header (e.g. "issues", "push", "issue_comment").
 * Narrow on `name`, and `payload` narrows to GitHub's matching webhook payload.
 */
export type GitHubWebhookEvent<Name extends GitHubWebhookEventName = GitHubWebhookEventName> = {
  [EventName in Name]: {
    readonly name: EventName
    /** Unique delivery id from the `X-GitHub-Delivery` header. */
    readonly deliveryId: string
    readonly payload: GitHubWebhookPayload<EventName>
  } & (GitHubWebhookAction<EventName> extends never
    ? { readonly action?: undefined }
    : { readonly action: GitHubWebhookAction<EventName> })
}[Name]

/**
 * Context passed to `onEvent` for each verified inbound delivery.
 *
 * `sixb` is the live runtime — use it to upsert objects, append telemetry, or
 * request actions. `client()` lazily resolves the GitHub client so the handler
 * can call back (e.g. comment on or update the issue) only when it needs to.
 */
export interface GitHubEventContext<Name extends GitHubWebhookEventName = GitHubWebhookEventName> {
  readonly event: GitHubWebhookEvent<Name>
  readonly sixb: Sixb<readonly OntologySource[]>
  client(): Promise<GitHubClient>
}

export type GitHubEventHandler<Name extends GitHubWebhookEventName = GitHubWebhookEventName> = (
  context: GitHubEventContext<Name>
) => Promise<void> | void

/** Payload delivered by the GitHub `issues` webhook event. */
export type GitHubIssueEvent = GitHubWebhookPayload<"issues">
