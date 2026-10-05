/** Compatible with the official Plaud MCP/CLI token files. Never log this object. */
export interface PlaudTokens {
  access_token: string
  refresh_token?: string
  token_type?: string
  /** Unix milliseconds. */
  expires_at?: number
  /** A refresh may have rotated the token without a durable response. Reauthorize to recover. */
  refresh_pending?: boolean
}

/** Implement withLock across all processes sharing this store. */
export interface PlaudTokenStore {
  load(): Promise<PlaudTokens | null>
  save(tokens: PlaudTokens): Promise<void>
  withLock<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>
}
