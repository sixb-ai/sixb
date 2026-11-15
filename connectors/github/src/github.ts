import { type RestConnectorOptions, type RestRequestContext, rest } from "@sixb/connector-rest"
import {
  type ConnectorAccessToken,
  type ConnectorAdapter,
  type ConnectorContext,
  type OAuthConnectorAdapter,
  resolveWebhookVerification,
} from "@sixb/core"
import { createAppInstallationTokenSource, type InstallationTokenHandle } from "./app-auth"
import { createGitHubClient } from "./client"
import { assertNonEmpty } from "./http"
import { createGitHubOAuth } from "./oauth"
import type { GitHubClient } from "./types/client"
import type {
  GitHubCommonOptions,
  GitHubConnectorOptions,
  GitHubOAuthConnectorOptions,
} from "./types/options"
import { createGitHubEventsWebhook, GITHUB_CONNECTOR_WEBHOOK } from "./webhook"

const GITHUB_API_BASE = "https://api.github.com/"
const GITHUB_API_VERSION = "2022-11-28"

export type GitHubConnector = ConnectorAdapter<"github", GitHubClient>
export type GitHubOAuthConnector = OAuthConnectorAdapter<"github", GitHubClient>

type GitHubRequestAuth = Pick<RestConnectorOptions, "headers" | "onUnauthorized">

/** GitHub REST API and webhooks, authenticated by Sixb-managed OAuth connections. */
export function github(options: GitHubOAuthConnectorOptions): GitHubOAuthConnector
/** GitHub REST API and webhooks, authenticated by a static token or GitHub App installation. */
export function github(options: GitHubConnectorOptions): GitHubConnector
export function github(
  options: GitHubConnectorOptions | GitHubOAuthConnectorOptions
): GitHubConnector | GitHubOAuthConnector {
  if (options.token !== undefined && options.auth !== undefined) {
    throw new Error("[SixbGitHub] Specify either token or auth, not both.")
  }

  const baseUrl = options.baseUrl ?? GITHUB_API_BASE
  const apiBaseUrl = ensureTrailingSlash(new URL(baseUrl))
  const webhooks = resolveWebhooks(options)

  if (isOAuthOptions(options)) {
    const { authentication, discoverAccounts } = createGitHubOAuth(options.auth.oauth, apiBaseUrl)
    return {
      type: "github",
      authentication,
      discoverAccounts,
      webhooks,
      connect(context) {
        const requestTokens = new WeakMap<RestRequestContext, ConnectorAccessToken>()
        return connectGitHub(context, baseUrl, apiBaseUrl, {
          async headers(request) {
            const token = await context.tokenSource.get()
            requestTokens.set(request, token)
            return githubHeaders(token.accessToken)
          },
          onUnauthorized: (request) => requestTokens.get(request)?.invalidate(),
        })
      },
    }
  }

  if (options.auth && "app" in options.auth && options.auth.app !== undefined) {
    const source = createAppInstallationTokenSource(options.auth.app, apiBaseUrl)
    return {
      type: "github",
      webhooks,
      connect(context) {
        const requestTokens = new WeakMap<RestRequestContext, InstallationTokenHandle>()
        return connectGitHub(context, baseUrl, apiBaseUrl, {
          async headers(request) {
            const token = await source.get(request.init.signal ?? undefined)
            requestTokens.set(request, token)
            return githubHeaders(token.accessToken)
          },
          onUnauthorized: (request) => requestTokens.get(request)?.invalidate(),
        })
      },
      async disconnect() {
        await source.revokeCurrent()
      },
    }
  }

  const token = options.auth && "token" in options.auth ? options.auth.token : options.token
  assertNonEmpty(token ?? "", "token")
  const headers = githubHeaders(token as string)

  return {
    type: "github",
    webhooks,
    connect(context) {
      return connectGitHub(context, baseUrl, apiBaseUrl, { headers })
    },
  }
}

async function connectGitHub(
  context: ConnectorContext,
  baseUrl: string,
  apiBaseUrl: URL,
  auth: GitHubRequestAuth
): Promise<GitHubClient> {
  const http = rest({
    baseUrl,
    ...auth,
    retry: { maxRetries: 2 },
  })
  return createGitHubClient(await http.connect(context), apiBaseUrl)
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  }
}

function resolveWebhooks(options: GitHubCommonOptions) {
  if (!options.onEvent) return undefined
  return [
    createGitHubEventsWebhook(
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
}

function ensureTrailingSlash(url: URL): URL {
  return url.pathname.endsWith("/") ? url : new URL(`${url.href}/`)
}

function isOAuthOptions(
  options: GitHubConnectorOptions | GitHubOAuthConnectorOptions
): options is GitHubOAuthConnectorOptions {
  return options.auth !== undefined && "oauth" in options.auth && options.auth.oauth !== undefined
}
