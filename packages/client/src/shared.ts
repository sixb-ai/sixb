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
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  readonly headers?: SixbClientOptions["headers"]
}

export interface SharedAccessClient {
  exchange(input: {
    readonly grantId: string
    readonly secret: string
  }): Promise<ExchangeSharedAccessResponse>
  getSession(grantId: string): Promise<GetSharedAccessSessionResponse>
  signOut(grantId: string): Promise<SignOutSharedAccessResponse>
}

/**
 * Creates an isolated client that can call only the shared protocol.
 *
 * It owns its CSRF state and never configures or reuses the normal Sixb browser client.
 */
export function createSharedAccessClient(
  options: SharedAccessClientOptions = {}
): SharedAccessClient {
  let csrfToken: string | null = null
  const client = createSixbClient({
    ...options,
    auth: { kind: "cookie", csrfToken: () => csrfToken },
  })

  return {
    async exchange(input) {
      assertGrantId(input.grantId)
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.secret)) {
        throw new Error("[SixbClient] Shared access secret is invalid.")
      }
      const { data } = await exchangeSharedAccess({
        client,
        path: { grantId: input.grantId },
        body: { secret: input.secret },
        throwOnError: true,
      })
      csrfToken = data.csrfToken
      return data
    },
    async getSession(grantId) {
      assertGrantId(grantId)
      const { data } = await getSharedAccessSession({
        client,
        path: { grantId },
        throwOnError: true,
      })
      csrfToken = data.authenticated ? data.csrfToken : null
      return data
    },
    async signOut(grantId) {
      assertGrantId(grantId)
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

function assertGrantId(grantId: string): void {
  if (!grantId.trim()) throw new Error("[SixbClient] Shared access grant id must not be empty.")
}
