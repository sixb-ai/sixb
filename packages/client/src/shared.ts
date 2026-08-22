import { createSixbClient, type SixbClientOptions } from "./api"
import {
  exchangeSharedAccess,
  getSharedAccessResource,
  getSharedAccessSession,
  requestSharedAccessAction,
  signOutSharedAccess,
} from "./generated/sdk.gen"
import type {
  ExchangeSharedAccessResponse,
  GetSharedAccessResourceResponse,
  GetSharedAccessSessionResponse,
  RequestSharedAccessActionData,
  RequestSharedAccessActionResponse,
  SignOutSharedAccessResponse,
} from "./generated/types.gen"

export type SharedAccessContext = ExchangeSharedAccessResponse
export type SharedAccessSession = GetSharedAccessSessionResponse
export type SharedAccessResource = GetSharedAccessResourceResponse
export type SharedAccessActionInput = RequestSharedAccessActionData["body"]
export type SharedAccessActionResult = RequestSharedAccessActionResponse

export interface SharedAccessClientOptions {
  readonly grantId: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  readonly headers?: SixbClientOptions["headers"]
}

export interface SharedAccessClient {
  exchange(secret: string): Promise<ExchangeSharedAccessResponse>
  getSession(): Promise<GetSharedAccessSessionResponse>
  getResource(): Promise<GetSharedAccessResourceResponse>
  requestAction(
    actionId: string,
    input?: RequestSharedAccessActionData["body"]
  ): Promise<RequestSharedAccessActionResponse>
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
    async getResource() {
      const { data } = await getSharedAccessResource({
        client,
        path: { grantId },
        throwOnError: true,
      })
      return data
    },
    async requestAction(actionId, input = {}) {
      assertActionId(actionId)
      const { data } = await requestSharedAccessAction({
        client,
        path: { grantId, actionId },
        body: input,
        throwOnError: true,
      })
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

function assertActionId(actionId: unknown): asserts actionId is string {
  if (typeof actionId !== "string" || !actionId.trim()) {
    throw new Error("[SixbClient] Shared access Action id must not be empty.")
  }
}

function assertGrantId(grantId: unknown): asserts grantId is string {
  if (typeof grantId !== "string" || !grantId.trim()) {
    throw new Error("[SixbClient] Shared access grant id must not be empty.")
  }
}
