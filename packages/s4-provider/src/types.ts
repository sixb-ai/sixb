export type ParioS4Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface CreateParioRemoteS4ProviderOptions {
  readonly baseUrl: string
  readonly fetch?: ParioS4Fetch
  readonly headers?: HeadersInit
}
