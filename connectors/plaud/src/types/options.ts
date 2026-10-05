import type { PlaudTokenStore } from "./auth"

export interface PlaudConnectionOptions {
  /** Defaults to ~/.plaud/tokens-sixb.json. Explicitly opt into tokens-mcp.json to reuse MCP login. */
  tokenFile?: string
  /** Alternative to tokenFile, for an application-owned secret store. */
  tokenStore?: PlaudTokenStore
  timeoutMs?: number
  /** Optional routing header used by the official Plaud client. */
  region?: string
}

export interface PlaudConnectorOptions extends PlaudConnectionOptions {
  /** Delay between API requests. Defaults to 0. */
  minDelayMs?: number
  /** Safe GET retries for network errors, 429 and 5xx. Defaults to 2. */
  maxRetries?: number
  /** Additional exact HTTPS hosts trusted for signed content downloads. */
  downloadHosts?: readonly string[]
  /** Maximum transcript/note body size, in bytes. Defaults to 20 MiB. */
  maxContentBytes?: number
}

export interface PlaudLoginOptions extends PlaudConnectionOptions {
  /** Defaults to the public native client shipped in @plaud-ai/mcp 0.3.13. */
  clientId?: string
  clientSecret?: string
  /** Must be registered with Plaud. Default: http://localhost:8199/auth/callback. */
  redirectUri?: string
  /** Open or display this URL to the user. Called after the loopback listener is ready. */
  onAuthorizationUrl(url: string): void | Promise<void>
  signal?: AbortSignal
  /** Total interactive login deadline. Defaults to 120 seconds. */
  loginTimeoutMs?: number
}
