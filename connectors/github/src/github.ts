import { rest } from "@sixb/connector-rest"
import { type ConnectorAdapter, resolveWebhookVerification } from "@sixb/core"
import { createGitHubClient } from "./client"
import { assertNonEmpty } from "./http"
import type { GitHubClient } from "./types/client"
import type { GitHubConnectorOptions } from "./types/options"
import { GITHUB_CONNECTOR_WEBHOOK, githubEventsWebhook } from "./webhook"

const GITHUB_API_BASE = "https://api.github.com/"
const GITHUB_API_VERSION = "2022-11-28"

export type GitHubConnector = ConnectorAdapter<"github", GitHubClient>

/**
 * GitHub connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client for repository and issue operations. When `onEvent`
 * is provided it also registers an inbound webhook that verifies GitHub's
 * signature and forwards every event to the handler.
 *
 * Register it from a project's `connectors/` directory:
 *
 * ```ts
 * export const githubConnector = defineConnector("github", github({
 *   token: process.env.GITHUB_TOKEN!,
 * }))
 * ```
 */
export function github(options: GitHubConnectorOptions): GitHubConnector {
  assertNonEmpty(options.token, "token")

  const apiBaseUrl = new URL(options.baseUrl ?? GITHUB_API_BASE)
  const http = rest({
    baseUrl: options.baseUrl ?? GITHUB_API_BASE,
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    retry: { maxRetries: 2 },
  })

  return {
    type: "github",
    webhooks: options.onEvent
      ? [
          githubEventsWebhook(
            {
              // The secret usually arrives from the environment, so the decision is made
              // here rather than by the type: a secret, an explicit opt-in, or no webhook.
              ...resolveWebhookVerification(GITHUB_CONNECTOR_WEBHOOK, {
                credential: options.webhookSecret,
                allowUnverified: options.webhookAllowUnverified,
              }),
              onEvent: options.onEvent,
            },
            GITHUB_CONNECTOR_WEBHOOK
          ),
        ]
      : undefined,
    async connect(context) {
      return createGitHubClient(await http.connect(context), apiBaseUrl)
    },
  }
}
