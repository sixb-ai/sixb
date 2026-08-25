export type LinkedinAccessTokenResolver = string | (() => string | Promise<string>)

export type LinkedinRequestMethod = "GET" | "POST" | "PUT" | "DELETE"

export interface LinkedinRetryContext {
  readonly attempt: number
  /** Logical method. A tunneled GET remains `GET`. */
  readonly method: LinkedinRequestMethod
  readonly response: Response | null
  readonly error: unknown
}

export interface LinkedinRetryPolicy {
  /** Number of retries after the initial request. Defaults to 2. */
  readonly maxRetries?: number
  shouldRetry?(context: LinkedinRetryContext): boolean
  delayMs?(context: LinkedinRetryContext): number
}

export interface LinkedinConnectorOptions {
  /** OAuth access token or a live resolver. The resolver is evaluated for every attempt. */
  readonly accessToken: LinkedinAccessTokenResolver
  /** LinkedIn Marketing API version in YYYYMM form. Defaults to 202608. */
  readonly version?: string
  /** Defaults to https://api.linkedin.com/rest/. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** Optional delay between requests. */
  readonly minDelayMs?: number
  /** By default, only transient logical GET failures are retried. */
  readonly retry?: LinkedinRetryPolicy
  /**
   * GET query-string length at which query tunneling is used. Defaults to 3,500 bytes, below
   * LinkedIn's 4 KB query-string limit. Set to 0 to tunnel every GET with a query string.
   */
  readonly queryTunnelingThreshold?: number
}
