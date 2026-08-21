import type { WebhookDefinition } from "../webhooks/types"

/**
 * Runtime context passed to connector adapters when Sixb establishes a connection.
 *
 * Connectors can use this to scope logs, build cache keys, or attach cancellation
 * to long-running startup work.
 */
export interface ConnectorContext {
  readonly projectId: string
  readonly connectorId: string
  readonly signal: AbortSignal
}

/**
 * Minimal contract for a Sixb connector adapter.
 *
 * Adapters are responsible for creating and optionally tearing down a client for an
 * external system. They should return the client shape that feels natural for that system.
 */
export interface ConnectorAdapter<TType extends string = string, TClient = unknown> {
  readonly type: TType
  readonly authentication?: never
  readonly webhooks?: readonly WebhookDefinition<unknown, TClient>[]
  connect(context: ConnectorContext): Promise<TClient> | TClient
  disconnect?(client: TClient): Promise<void> | void
}

/** One OAuth token set normalized by an OAuth connector adapter. */
export interface ConnectorOAuthCredentials {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly tokenType?: string
  readonly scopes?: readonly string[]
  readonly expiresAt?: Date
}

/** Public, non-secret account information returned for framework-owned selection UI. */
export interface ConnectorAccountCandidate {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly avatarUrl?: string
}

/** V1 intentionally supports project-owned connector connections only. */
export interface ProjectConnectorConnectionOwner {
  readonly type: "project"
}

export type ConnectorConnectionOwner = ProjectConnectorConnectionOwner

/** Stable application-defined lookup key for one connector connection. */
export interface ConnectorConnectionSelector {
  readonly owner: ConnectorConnectionOwner
  readonly slot: string
}

/** Credential protection required when an OAuth connector uses durable connection storage. */
export interface ConnectorConnectionOptions {
  /** Canonical base64url encoding of exactly 32 random bytes, shared by storage replicas. */
  readonly encryptionKey: string
}

export interface OAuthConnectorAuthorizationContext extends ConnectorContext {
  readonly redirectUri: string
}

export interface OAuthConnectorAuthorizationUrlInput {
  readonly state: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: "S256"
}

export interface OAuthConnectorCodeExchangeInput {
  readonly code: string
  readonly codeVerifier: string
}

export interface ConnectorConnectionClientContext extends ConnectorContext {
  readonly connectionId: string
  readonly account: ConnectorAccountCandidate
  readonly tokenSource: ConnectorTokenSource
}

/** Live credential source owned by Sixb. Adapters must not capture an access token at creation. */
export interface ConnectorTokenSource {
  get(): Promise<{ readonly accessToken: string; readonly tokenType?: string }>
  invalidate(): void
}

/**
 * OAuth-backed connector adapter. Sixb owns persistence, OAuth state, refresh coordination and UI;
 * the adapter owns provider protocol details and typed client creation.
 */
export interface ConnectorOAuth2Authentication {
  readonly type: "oauth2"
  authorizationUrl(
    context: OAuthConnectorAuthorizationContext,
    input: OAuthConnectorAuthorizationUrlInput
  ): Promise<string | URL> | string | URL
  exchangeCode(
    context: OAuthConnectorAuthorizationContext,
    input: OAuthConnectorCodeExchangeInput
  ): Promise<ConnectorOAuthCredentials> | ConnectorOAuthCredentials
  refresh(
    context: ConnectorContext,
    credentials: ConnectorOAuthCredentials
  ): Promise<ConnectorOAuthCredentials> | ConnectorOAuthCredentials
  revoke?(context: ConnectorContext, credentials: ConnectorOAuthCredentials): Promise<void> | void
}

export interface OAuthConnectorAdapter<TType extends string = string, TClient = unknown> {
  readonly type: TType
  readonly authentication: ConnectorOAuth2Authentication
  readonly webhooks?: undefined
  discoverAccounts(
    context: ConnectorContext,
    credentials: ConnectorOAuthCredentials
  ): Promise<readonly ConnectorAccountCandidate[]> | readonly ConnectorAccountCandidate[]
  connect(context: ConnectorConnectionClientContext): Promise<TClient> | TClient
}

export type AnyConnectorAdapter = ConnectorAdapter | OAuthConnectorAdapter

/**
 * Inert connector definition registered with Sixb.
 *
 * Definitions are safe to export from `connectors/` modules. The runtime turns them into
 * live clients when `sixb.connector(...)` is called.
 */
export interface ConnectorDefinition<
  TId extends string = string,
  TAdapter extends AnyConnectorAdapter = AnyConnectorAdapter,
> {
  readonly kind: "connector"
  readonly id: TId
  readonly adapter: TAdapter
}

export type StaticConnectorDefinition = ConnectorDefinition<string, ConnectorAdapter>

/** Infer the connected client type returned by a connector adapter. */
export type ConnectorClient<TAdapter extends AnyConnectorAdapter> = Awaited<
  ReturnType<TAdapter["connect"]>
>

export function isOAuthConnectorAdapter(
  value: AnyConnectorAdapter
): value is OAuthConnectorAdapter {
  return "authentication" in value && value.authentication?.type === "oauth2"
}

export function isOAuthConnectorDefinition(
  value: ConnectorDefinition
): value is ConnectorDefinition<string, OAuthConnectorAdapter> {
  return isOAuthConnectorAdapter(value.adapter)
}

export function isStaticConnectorDefinition(
  value: ConnectorDefinition
): value is StaticConnectorDefinition {
  return !isOAuthConnectorDefinition(value)
}

export function isConnectorDefinition(value: unknown): value is ConnectorDefinition {
  if (!isRecord(value)) {
    return false
  }

  const adapter = value.adapter
  if (
    value.kind === "connector" &&
    typeof value.id === "string" &&
    isRecord(adapter) &&
    typeof adapter.type === "string" &&
    typeof adapter.connect === "function"
  ) {
    if (adapter.authentication === undefined) return true
    const authentication = adapter.authentication
    if (!isRecord(authentication) || authentication.type !== "oauth2") return false
    return (
      typeof authentication.authorizationUrl === "function" &&
      typeof authentication.exchangeCode === "function" &&
      typeof authentication.refresh === "function" &&
      typeof adapter.discoverAccounts === "function"
    )
  }

  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
