import type { GitHubEventHandler } from "./webhook"

export interface GitHubConnectorOptions {
  /** GitHub token. A fine-grained personal access token is recommended. */
  readonly token: string
  /** API base URL. Override for GitHub Enterprise Server. */
  readonly baseUrl?: string
  /** Shared secret used to verify inbound webhook deliveries (X-Hub-Signature-256). */
  readonly webhookSecret?: string
  /**
   * Register the inbound webhook even though it cannot be verified.
   *
   * Without `webhookSecret` the route accepts unsigned requests from anyone who can
   * reach it, so the connector refuses to build it unless this says otherwise.
   */
  readonly webhookAllowUnsigned?: boolean
  /** Invoked for each verified inbound webhook delivery, for any event type. */
  readonly onEvent?: GitHubEventHandler
}
