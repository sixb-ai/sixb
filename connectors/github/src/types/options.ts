import type { GitHubEventHandler } from "./webhook"

export interface GitHubAppAuthOptions {
  /** Numeric GitHub App ID. */
  readonly appId: string
  /** PEM-encoded RSA private key. Escaped `\n` newlines are accepted. */
  readonly privateKey: string
  /** Numeric GitHub App installation ID used for this connector's API calls. */
  readonly installationId: string | number
}

export interface GitHubOAuthOptions {
  /** GitHub App (or OAuth App) client ID. */
  readonly clientId: string
  /** GitHub App (or OAuth App) client secret. */
  readonly clientSecret: string
  /**
   * Web origin for OAuth endpoints (`/login/oauth/authorize` and `/login/oauth/access_token`).
   * Defaults to `"https://github.com"`, or the web host derived from `baseUrl` for GitHub Enterprise.
   */
  readonly webBaseUrl?: string
  /**
   * Optional OAuth scopes. Leave omitted for GitHub Apps (`offline_access` is requested
   * automatically); pass scopes such as `["repo", "read:user"]` only for classic OAuth Apps.
   */
  readonly scopes?: readonly string[]
  /** Defaults to `"S256"`. Set `"disabled"` only for classic OAuth Apps that reject PKCE. */
  readonly pkce?: "S256" | "disabled"
}

export type GitHubStaticAuthOptions =
  | { readonly token: string; readonly app?: never; readonly oauth?: never }
  | { readonly app: GitHubAppAuthOptions; readonly token?: never; readonly oauth?: never }

export interface GitHubOAuthAuthOptions {
  readonly oauth: GitHubOAuthOptions
  readonly token?: never
  readonly app?: never
}

export interface GitHubCommonOptions {
  /** API base URL. Override for GitHub Enterprise Cloud or Server. */
  readonly baseUrl?: string
  /** Shared secret used to verify inbound webhook deliveries (X-Hub-Signature-256). */
  readonly webhookSecret?: string
  /**
   * Register the inbound webhook even though it cannot be verified.
   *
   * Without `webhookSecret` the route accepts unverified requests from anyone who can
   * reach it, so the connector refuses to build it unless this says otherwise.
   */
  readonly webhookAllowUnverified?: boolean
  /** Invoked for each verified inbound webhook delivery, for any event type. */
  readonly onEvent?: GitHubEventHandler
}

export type GitHubConnectorOptions = GitHubCommonOptions &
  (
    | {
        /** GitHub token. A fine-grained personal access token is recommended. */
        readonly token: string
        readonly auth?: never
      }
    | {
        /** Process-wide GitHub authentication: a token or a GitHub App installation. */
        readonly auth: GitHubStaticAuthOptions
        readonly token?: never
      }
  )

/** A GitHub connector whose accounts are connected through Sixb-managed OAuth. */
export interface GitHubOAuthConnectorOptions extends GitHubCommonOptions {
  readonly auth: GitHubOAuthAuthOptions
  readonly token?: never
}
