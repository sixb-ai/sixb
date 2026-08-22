import { createSixbClient, type SixbClientOptions } from "./api"
import {
  exchangeSharedAccess,
  getSharedAccessSession,
  signOutSharedAccess,
} from "./generated/sdk.gen"
import type {
  ExchangeSharedAccessResponse,
  GetSharedAccessSessionResponse,
  SignOutSharedAccessResponse,
} from "./generated/types.gen"

export type SharedAccessContext = ExchangeSharedAccessResponse
export type SharedAccessSession = GetSharedAccessSessionResponse

export interface SharedAccessClientOptions {
  readonly grantId: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  readonly headers?: SixbClientOptions["headers"]
}

export interface SharedAccessClient {
  exchange(secret: string): Promise<ExchangeSharedAccessResponse>
  getSession(): Promise<GetSharedAccessSessionResponse>
  signOut(): Promise<SignOutSharedAccessResponse>
}

/**
 * Creates an isolated client that can call only the shared protocol.
 *
 * It owns its CSRF state and never configures or reuses the normal Sixb browser client.
 */
export function createSharedAccessClient(options: SharedAccessClientOptions): SharedAccessClient {
  const configuredGrantId = options?.grantId
  assertGrantId(configuredGrantId)
  const { grantId, ...clientOptions } = options
  let csrfToken: string | null = null
  const client = createSixbClient({
    ...clientOptions,
    auth: { kind: "cookie", csrfToken: () => csrfToken },
  })

  return {
    async exchange(secret) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
        throw new Error("[SixbClient] Shared access secret is invalid.")
      }
      const { data } = await exchangeSharedAccess({
        client,
        path: { grantId },
        body: { secret },
        throwOnError: true,
      })
      csrfToken = data.csrfToken
      return data
    },
    async getSession() {
      const { data } = await getSharedAccessSession({
        client,
        path: { grantId },
        throwOnError: true,
      })
      csrfToken = data.authenticated ? data.csrfToken : null
      return data
    },
    async signOut() {
      const { data } = await signOutSharedAccess({
        client,
        path: { grantId },
        throwOnError: true,
      })
      csrfToken = null
      return data
    },
  }
}

function assertGrantId(grantId: unknown): asserts grantId is string {
  if (typeof grantId !== "string" || !grantId.trim()) {
    throw new Error("[SixbClient] Shared access grant id must not be empty.")
  }
}
