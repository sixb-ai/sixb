export interface PlaudClientRegistrationOptions {
  /** Exact Sixb API callback URLs. HTTPS, or HTTP on loopback for local development. */
  redirectUris: readonly string[]
  /** Display name registered with Plaud. Defaults to Sixb. */
  clientName?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface PlaudClientRegistration {
  /** Public OAuth client identifier. Save it as deployment configuration. */
  clientId: string
  redirectUris: readonly string[]
}
