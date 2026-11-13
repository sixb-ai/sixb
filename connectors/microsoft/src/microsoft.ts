import { type RestConnectorOptions, type RestRequestContext, rest } from "@sixb/connector-rest"
import {
  type ConnectorAccessToken,
  type ConnectorAdapter,
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
  type OAuthConnectorAdapter,
} from "@sixb/core"
import { createTokenSource, validateAuth } from "./auth"
import { createMicrosoftOAuth } from "./auth/oauth"
import { createMicrosoftClient, type MicrosoftClient } from "./client"
import { type ClientStateSource, personalClientState } from "./client-state"
import { MicrosoftConfigurationError } from "./errors"
import { createMicrosoftHttp } from "./http"
import { withSignal } from "./lifetime"
import { deletePersonalSubscriptions } from "./surfaces/subscriptions/cleanup"
import { validateWebhookSecret } from "./surfaces/subscriptions/validation"
import type { MicrosoftConnectorOptions, MicrosoftOAuthConnectorOptions } from "./types/common"
import { GRAPH_BASE } from "./validation"
import { microsoftEventsWebhook, microsoftOAuthEventsWebhook } from "./webhooks"

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
  validateNotifications(options)
  const timeoutMs = validTimeout(options.timeoutMs)
  const secret = options.webhookSecret
  return {
    type: "microsoft",
    webhooks:
      options.onEvent && secret !== undefined
        ? [microsoftEventsWebhook(secret, options.onEvent)]
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
        timeoutMs,
        secret === undefined ? undefined : () => secret
      )
    },
  }
}

function microsoftOAuth(options: MicrosoftOAuthConnectorOptions): MicrosoftOAuthConnector {
  validateNotifications(options)
  const timeoutMs = validTimeout(options.timeoutMs)
  const secret = options.webhookSecret
  const { authentication, discoverAccounts } = createMicrosoftOAuth(options.auth.oauth, timeoutMs)
  return {
    type: "microsoft",
    authentication:
      secret === undefined
        ? authentication
        : {
            ...authentication,
            revoke: (context, credentials) =>
              deleteSubscriptionsOnRevoke(context, credentials, {
                accountId: () => discoverAccounts(context, credentials)[0]?.id,
                refresh: authentication.refresh,
                options,
                timeoutMs,
              }),
          },
    discoverAccounts,
    webhooks:
      options.onEvent && secret !== undefined
        ? [microsoftOAuthEventsWebhook(secret, options.onEvent)]
        : undefined,
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
        timeoutMs,
        // Signed on use, so an account id the signature can't carry fails only subscribing.
        secret === undefined ? undefined : () => personalClientState(secret, context.account.id)
      )
    },
  }
}

/**
 * Entra has no way for an application to revoke one person's grant, but the subscriptions this
 * connector made for them can still go. Graph accepts only their own token for that, and Sixb is
 * about to drop it. Best effort: a subscription left behind expires within seven days, and until
 * then its notifications reach `onEvent` with no connections.
 */
async function deleteSubscriptionsOnRevoke(
  context: ConnectorContext,
  credentials: ConnectorOAuthCredentials,
  using: {
    readonly accountId: () => string | undefined
    readonly refresh: ConnectorOAuth2Authentication["refresh"]
    readonly options: MicrosoftOAuthConnectorOptions
    readonly timeoutMs: number
  }
): Promise<void> {
  try {
    const accountId = using.accountId()
    if (accountId === undefined) return
    const { accessToken } =
      credentials.expiresAt === undefined || credentials.expiresAt.getTime() > Date.now() + 60_000
        ? credentials
        : await using.refresh(context, credentials)
    const graph = await connectGraph(
      context,
      { headers: () => ({ Authorization: `Bearer ${accessToken}` }) },
      using.options,
      using.timeoutMs,
      undefined
    )
    const { failed } = await deletePersonalSubscriptions(
      graph.subscriptions,
      accountId,
      `/api/webhooks/${context.connectorId}/events`
    )
    if (failed > 0)
      console.warn(
        `[SixbMicrosoft] ${failed} subscription(s) of a revoked connection could not be deleted; they expire within seven days.`
      )
  } catch (error) {
    // A grant Entra already refuses, or one that names no account, can't delete anything.
    if (error instanceof ConnectorOAuthError && error.kind === "terminal") return
    console.warn(
      "[SixbMicrosoft] The subscriptions of a revoked connection could not be deleted; they expire within seven days.",
      error instanceof Error ? error.message : error
    )
  }
}

async function connectGraph(
  context: ConnectorContext,
  auth: GraphAuth,
  options: MicrosoftConnectorOptions | MicrosoftOAuthConnectorOptions,
  timeoutMs: number,
  clientState: ClientStateSource | undefined
): Promise<MicrosoftClient> {
  const common = restOptions(options, timeoutMs)
  const graph = await rest({ ...common, ...auth, baseUrl: GRAPH_BASE }).connect(context)
  const media = await rest({ ...common, baseUrl: GRAPH_BASE }).connect(context)
  return createMicrosoftClient(createMicrosoftHttp(graph, media, context.signal), clientState)
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

function validateNotifications(
  options: MicrosoftConnectorOptions | MicrosoftOAuthConnectorOptions
): void {
  if (options.webhookSecret !== undefined) validateWebhookSecret(options.webhookSecret)
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new MicrosoftConfigurationError("onEvent must be a function.")
  }
  if (options.onEvent && options.webhookSecret === undefined) {
    throw new MicrosoftConfigurationError("webhookSecret is required when onEvent is configured.")
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
