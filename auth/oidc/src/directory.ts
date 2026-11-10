import type { OidcClaims } from "./claims"

/**
 * The identity provider's directory, read with the app registration the strategy signs people in
 * with. Pass one to `oidc({ directory })`, and Sixb checks everyone who signed in every
 * `intervalMs`: a person the directory reports `inactive` is suspended, and the claims an `active`
 * answer returns go through the strategy's `groups`, as they would at sign-in.
 */
export interface OidcDirectory {
  /** How often to check, at least one minute. Defaults to one hour. */
  readonly intervalMs?: number
  /**
   * How long after a change the directory may still answer from before it. Suspending or
   * reactivating someone takes two reads this far apart that agree. Defaults to one minute.
   */
  readonly confirmAfterMs?: number
  /**
   * The verdict on each identity, keyed by subject. Leave out an identity the directory cannot
   * answer for, and nothing changes for it. Throw when the check as a whole fails.
   */
  check(input: OidcDirectoryCheckInput): Promise<ReadonlyMap<string, OidcDirectoryVerdict>>
}

export interface OidcDirectoryCheckInput {
  /** The app registration the strategy signs people in with. */
  readonly app: OidcDirectoryApp
  readonly identities: readonly OidcDirectoryIdentity[]
  readonly signal: AbortSignal
}

export interface OidcDirectoryApp {
  readonly issuer: URL
  readonly clientId: string
  readonly clientSecret: string
}

/** Someone who signed in, with the claims of their last sign-in. */
export interface OidcDirectoryIdentity {
  readonly subject: string
  readonly claims: OidcClaims
}

export type OidcDirectoryVerdict =
  | {
      readonly status: "active"
      /**
       * Claims as the provider would send them now, such as the person's current `roles`. They are
       * merged over the last sign-in's and passed to `groups`. Omitted, groups stay as they are.
       */
      readonly claims?: Partial<OidcClaims>
    }
  /** Disabled, deleted, or no longer assigned the app. */
  | { readonly status: "inactive" }
