import type { MetaResponseMetadata, MetaRetryPolicy } from "./common"

/** Transport options shared by the system-token and OAuth connectors. */
export interface MetaTransportOptions {
  /** Graph API version segment, e.g. "v23.0". Defaults to the connector's pinned version. */
  readonly graphVersion?: string
  /** Full base URL override (takes precedence over `graphVersion`). Mainly for tests. */
  readonly baseUrl?: string
  /** @deprecated Prefer `retry.maxRetries`. */
  readonly maxRetries?: number
  /** Retry policy for transient HTTP failures and Meta throttling errors. */
  readonly retry?: MetaRetryPolicy
  /** Observe response headers and parsed quota usage without wrapping resource return values. */
  readonly onResponse?: (metadata: MetaResponseMetadata) => Promise<void> | void
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number
}

export interface MetaConnectorOptions extends MetaTransportOptions {
  /** Long-lived User or System-User access token. Required. */
  readonly accessToken: string
  readonly appId?: never
  readonly accounts?: never
}

interface MetaOAuthBaseOptions extends MetaTransportOptions {
  /** Meta app ID. */
  readonly appId: string
  /** Meta app secret. Used server-side only, for the code and token exchanges. */
  readonly appSecret: string
  readonly accessToken?: never
}

/**
 * Sign in with Facebook and connect the Pages the user grants. Pass `configId` for Facebook Login
 * for Business (Business apps) or `scopes` for Facebook Login.
 */
export type MetaOAuthConnectorOptions = MetaOAuthBaseOptions & { readonly accounts?: "pages" } & (
    | {
        /** Facebook Login for Business configuration, of the "User access token" type. */
        readonly configId: string
        readonly scopes?: never
      }
    | {
        /** Facebook Login permissions, e.g. `pages_show_list` and `pages_manage_posts`. */
        readonly scopes: readonly string[]
        readonly configId?: never
      }
  )

interface MetaInstagramBaseOptions extends MetaOAuthBaseOptions {
  readonly accounts: "instagram"
}

/**
 * Connect Instagram professional accounts without a Facebook Page. Each connection is one account.
 *
 * - Unified Login (`configId`): the client logs in with Instagram or Facebook, picks a business
 *   portfolio and the accounts to share. Read and published through `graph.facebook.com` with the
 *   grant's Business Integration System User token. `appId` and `appSecret` are the Meta app's.
 * - Instagram Login (`login: "instagram"`): the client signs in on instagram.com with the account's
 *   own credentials; no Page and no business portfolio. Read and published through
 *   `graph.instagram.com` with a 60-day Instagram user token the connector refreshes. `appId` and
 *   `appSecret` are the Instagram app's, from "API setup with Instagram login".
 */
export type MetaInstagramOAuthConnectorOptions =
  | (MetaInstagramBaseOptions & {
      /** Facebook Login for Business configuration of the "System-user access token" type (Unified login). */
      readonly configId: string
      readonly login?: never
      readonly scopes?: never
    })
  | (MetaInstagramBaseOptions & {
      readonly login: "instagram"
      /**
       * Instagram Login permissions. Defaults to `instagram_business_basic`,
       * `instagram_business_content_publish` and `instagram_business_manage_insights`.
       */
      readonly scopes?: readonly string[]
      /**
       * Ask for the account's credentials on every sign-in, even when the browser is signed in to
       * Instagram (`force_reauth`), so several accounts connect one after the other.
       */
      readonly reauthenticate?: boolean
      readonly configId?: never
    })
