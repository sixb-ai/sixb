/** A Google service-account key, as found in the JSON key file. */
export interface ServiceAccountKey {
  readonly client_email: string
  /** PEM-encoded PKCS#8 private key (`-----BEGIN PRIVATE KEY-----`). */
  readonly private_key: string
  /** Token endpoint override; defaults to Google's global endpoint. */
  readonly token_uri?: string
}

export type GoogleAuthOptions =
  | {
      /** Discover credentials from the runtime environment through Google's ADC strategy. */
      readonly applicationDefault: true
      /** OAuth scopes to request; the union across every surface you call. */
      readonly scopes: readonly string[]
    }
  | {
      /** Service-account key (parsed object or its JSON string). Connector mints tokens. */
      readonly serviceAccountKey: string | ServiceAccountKey
      /** OAuth scopes to request; the union across every surface you call. */
      readonly scopes: readonly string[]
      /** Impersonate ONE fixed user (domain-wide delegation). See the package README. */
      readonly subject?: string
    }
  | {
      /** Caller mints tokens elsewhere and owns scopes + refresh. */
      readonly token: () => string | Promise<string>
    }

/** A Google OAuth client whose grants Sixb stores, refreshes, and serves as connector connections. */
export interface GoogleOAuthOptions {
  /** Client ID of a Google Cloud OAuth client of type "Web application". */
  readonly clientId: string
  readonly clientSecret: string
  /**
   * API scopes to request; the union across every surface you call. `openid` and the account
   * email scope are always added so Sixb can identify the connected account.
   */
  readonly scopes: readonly string[]
  /** Accept only Google Workspace accounts of this domain, such as `example.com`. */
  readonly hostedDomain?: string
}

export interface TokenSource {
  /** Resolve a bearer access token, refreshing it when the auth mode supports refresh. */
  get(): Promise<string>
  /** Resolve every required auth header. Optional for compatibility with custom token sources. */
  getRequestHeaders?(): Promise<Headers>
  /** Invalidate the current token; called by the REST adapter's auth retry on a 401. */
  invalidate(): void
}
