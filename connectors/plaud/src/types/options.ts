export interface PlaudConnectorOptions {
  /** Public client ID obtained from registerPlaudClient(), not the native MCP client ID. */
  clientId: string
  timeoutMs?: number
  /** Optional routing header for direct Plaud API requests. */
  region?: string
  /** Delay between API requests. Defaults to 0. */
  minDelayMs?: number
  /** Safe GET retries for network errors, 429 and 5xx. Defaults to 2. */
  maxRetries?: number
  /** Additional exact HTTPS hosts trusted for signed content downloads. */
  downloadHosts?: readonly string[]
  /** Maximum transcript/note body size, in bytes. Defaults to 20 MiB. */
  maxContentBytes?: number
}
