import type { GitHubEventHandler } from "./webhook"

export interface GitHubConnectorOptions {
  /** GitHub token. A fine-grained personal access token is recommended. */
  readonly token: string
  /** API base URL. Override for GitHub Enterprise Server. */
  readonly baseUrl?: string
  /** Shared secret used to verify inbound webhook deliveries (X-Hub-Signature-256). */
  readonly webhookSecret?: string
  /** Invoked for each verified inbound webhook delivery, for any event type. */
  readonly onEvent?: GitHubEventHandler
}
