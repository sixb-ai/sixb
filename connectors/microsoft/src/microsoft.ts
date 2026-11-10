import { type RestConnectorOptions, type RestRequestContext, rest } from "@sixb/connector-rest"
import type {
  ConnectorAccessToken,
  ConnectorAdapter,
  ConnectorContext,
  OAuthConnectorAdapter,
} from "@sixb/core"
import { createTokenSource, validateAuth } from "./auth"
import { createMicrosoftOAuth } from "./auth/oauth"
import { createMicrosoftClient, type MicrosoftClient } from "./client"
import { MicrosoftConfigurationError } from "./errors"
import { createMicrosoftHttp } from "./http"
import { withSignal } from "./lifetime"
import { validateWebhookSecret } from "./surfaces/subscriptions/validation"
import type { MicrosoftConnectorOptions, MicrosoftOAuthConnectorOptions } from "./types/common"
import { GRAPH_BASE } from "./validation"
import { microsoftEventsWebhook } from "./webhooks"

export type MicrosoftConnector = ConnectorAdapter<"microsoft", MicrosoftClient>
export type MicrosoftOAuthConnector = OAuthConnectorAdapter<"microsoft", MicrosoftClient>

type GraphAuth = Pick<RestConnectorOptions, "headers" | "onUnauthorized">

/** Microsoft Graph as each person who connects their own account (delegated permissions). */
export function microsoft(options: MicrosoftOAuthConnectorOptions): MicrosoftOAuthConnector
/** Microsoft Graph as the application itself, or with a token the caller supplies. */
export function microsoft(options: MicrosoftConnectorOptions): MicrosoftConnector
export function microsoft(
  options: MicrosoftConnectorOptions | MicrosoftOAuthConnectorOptions
): MicrosoftConnector | MicrosoftOAuthConnector {
  return isOAuthOptions(options) ? microsoftOAuth(options) : microsoftApplication(options)
}

function microsoftApplication(options: MicrosoftConnectorOptions): MicrosoftConnector {
  validateAuth(options.auth)
  if (options.webhookSecret !== undefined) validateWebhookSecret(options.webhookSecret)
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new MicrosoftConfigurationError("onEvent must be a function.")
  }
  if (options.onEvent && options.webhookSecret === undefined) {
    throw new MicrosoftConfigurationError("webhookSecret is required when onEvent is configured.")
  }
  const timeoutMs = validTimeout(options.timeoutMs)
  return {
    type: "microsoft",
    webhooks:
      options.onEvent && options.webhookSecret !== undefined
        ? [microsoftEventsWebhook(options.webhookSecret, options.onEvent)]
        : undefined,
    async connect(context) {
      const authHttp = await rest({
        ...restOptions(options, timeoutMs),
        baseUrl: "https://login.microsoftonline.com/",
      }).connect(context)
      const token = createTokenSource(options.auth, authHttp, context.signal, timeoutMs)
      return connectGraph(
        context,
        {
          headers: async (request) => ({
            Authorization: `Bearer ${await withSignal(token.get(), request.init.signal ?? context.signal)}`,
          }),
          onUnauthorized: () => token.invalidate(),
        },
        options,
        timeoutMs
      )
    },
  }
}

function microsoftOAuth(options: MicrosoftOAuthConnectorOptions): MicrosoftOAuthConnector {
  const timeoutMs = validTimeout(options.timeoutMs)
  const { authentication, discoverAccounts } = createMicrosoftOAuth(options.auth.oauth, timeoutMs)
  return {
    type: "microsoft",
    authentication,
    discoverAccounts,
    connect(context) {
      // A 401 must invalidate the exact token that request sent, not whichever is current now.
      const requestTokens = new WeakMap<RestRequestContext, ConnectorAccessToken>()
      return connectGraph(
        context,
        {
          async headers(request) {
            const token = await withSignal(
              context.tokenSource.get(),
              request.init.signal ?? context.signal
            )
            requestTokens.set(request, token)
            return { Authorization: `Bearer ${token.accessToken}` }
          },
          onUnauthorized: (request) => requestTokens.get(request)?.invalidate(),
        },
        options,
        timeoutMs
      )
    },
  }
}

async function connectGraph(
  context: ConnectorContext,
  auth: GraphAuth,
  options: MicrosoftConnectorOptions | MicrosoftOAuthConnectorOptions,
  timeoutMs: number
): Promise<MicrosoftClient> {
  const common = restOptions(options, timeoutMs)
  const graph = await rest({ ...common, ...auth, baseUrl: GRAPH_BASE }).connect(context)
  const media = await rest({ ...common, baseUrl: GRAPH_BASE }).connect(context)
  return createMicrosoftClient(
    createMicrosoftHttp(graph, media, context.signal),
    "webhookSecret" in options ? options.webhookSecret : undefined
  )
}

function restOptions(
  options: MicrosoftConnectorOptions | MicrosoftOAuthConnectorOptions,
  timeoutMs: number
) {
  return {
    timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: options.retry ?? { maxRetries: 2 },
  }
}

function validTimeout(timeoutMs = 30_000): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new MicrosoftConfigurationError("timeoutMs must be a positive integer.")
  return timeoutMs
}

function isOAuthOptions(
  options: MicrosoftConnectorOptions | MicrosoftOAuthConnectorOptions
): options is MicrosoftOAuthConnectorOptions {
  return "oauth" in options.auth
}
