import { type RestRequestContext, rest } from "@sixb/connector-rest"
import type {
  ConnectorAccessToken,
  ConnectorContext,
  ConnectorOAuthCredentials,
  ConnectorTokenSource,
  OAuthConnectorAdapter,
} from "@sixb/core"
import {
  assertDiscoveryScopes,
  connectedLinkedinAccount,
  discoverLinkedinAccounts,
} from "./accounts"
import { createLinkedinClient } from "./client"
import { LinkedinConfigurationError } from "./errors"
import { createLinkedinHttp, type LinkedinHttp } from "./http"
import { createLinkedinOAuth } from "./oauth"
import { assertNonEmpty } from "./restli"
import type { LinkedinClient } from "./types/client"
import type { LinkedinConnectorOptions } from "./types/options"

export const DEFAULT_LINKEDIN_BASE_URL = "https://api.linkedin.com/rest/"
export const DEFAULT_LINKEDIN_VERSION = "202608"
export const LINKEDIN_RESTLI_PROTOCOL_VERSION = "2.0.0"
const DEFAULT_QUERY_TUNNELING_THRESHOLD = 3_500

export type LinkedinConnector = OAuthConnectorAdapter<"linkedin", LinkedinClient>

/** LinkedIn Advertising and Community Management adapter backed by Sixb-managed OAuth. */
export function linkedin(options: LinkedinConnectorOptions): LinkedinConnector {
  const authentication = createLinkedinOAuth(options)
  const version = options.version ?? DEFAULT_LINKEDIN_VERSION
  if (!/^\d{6}$/.test(version)) {
    throw new Error("[SixbLinkedin] version must use LinkedIn's YYYYMM format.")
  }
  assertDiscoveryScopes(options.accountType, options.scopes)

  const resolvedOptions: ResolvedLinkedinOptions = {
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_LINKEDIN_BASE_URL),
    version,
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: options.retry,
    queryTunnelingThreshold: options.queryTunnelingThreshold ?? DEFAULT_QUERY_TUNNELING_THRESHOLD,
  }

  return {
    type: "linkedin",
    authentication: {
      type: "oauth2",
      ...authentication,
    },
    async discoverAccounts(context, credentials) {
      const http = await createHttp(context, fixedTokenSource(credentials), resolvedOptions, false)
      return discoverLinkedinAccounts(options.accountType, http)
    },
    async connect(context) {
      const http = await createHttp(context, context.tokenSource, resolvedOptions, true)
      return createLinkedinClient(
        http,
        connectedLinkedinAccount(options.accountType, context.account)
      )
    },
  }
}

interface ResolvedLinkedinOptions {
  readonly baseUrl: string
  readonly version: string
  readonly timeoutMs: LinkedinConnectorOptions["timeoutMs"]
  readonly minDelayMs: LinkedinConnectorOptions["minDelayMs"]
  readonly retry: LinkedinConnectorOptions["retry"]
  readonly queryTunnelingThreshold: number
}

async function createHttp(
  context: ConnectorContext,
  tokenSource: ConnectorTokenSource,
  options: ResolvedLinkedinOptions,
  invalidateUnauthorized: boolean
): Promise<LinkedinHttp> {
  const requestTokens = new WeakMap<RestRequestContext, ConnectorAccessToken>()
  const restAdapter = rest({
    baseUrl: options.baseUrl,
    headers: async (requestContext) => {
      const token = await tokenSource.get()
      if (!token.accessToken.trim()) {
        throw new LinkedinConfigurationError(
          "[SixbLinkedin] managed OAuth returned an empty access token."
        )
      }
      requestTokens.set(requestContext, token)
      return {
        Accept: "application/json",
        Authorization: `${token.tokenType ?? "Bearer"} ${token.accessToken}`,
        "Linkedin-Version": options.version,
        "X-Restli-Protocol-Version": LINKEDIN_RESTLI_PROTOCOL_VERSION,
      }
    },
    timeoutMs: options.timeoutMs,
    onUnauthorized: invalidateUnauthorized
      ? (requestContext) => requestTokens.get(requestContext)?.invalidate()
      : undefined,
    // Logical-method-aware retries and query tunneling live in the LinkedIn HTTP layer.
    retry: { maxRetries: 0 },
  })
  const client = await restAdapter.connect(context)
  return createLinkedinHttp(client, {
    minDelayMs: options.minDelayMs,
    retry: options.retry,
    signal: context.signal,
    queryTunnelingThreshold: options.queryTunnelingThreshold,
  })
}

function fixedTokenSource(credentials: ConnectorOAuthCredentials): ConnectorTokenSource {
  return {
    async get() {
      return {
        accessToken: credentials.accessToken,
        tokenType: credentials.tokenType,
        invalidate() {},
      }
    },
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  assertNonEmpty(baseUrl, "baseUrl")
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}
