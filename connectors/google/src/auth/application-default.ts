import { isSixbError, type SixbError } from "@sixb/core/errors"
import { GoogleAuth } from "google-auth-library"
import { googleAuthError } from "../errors"
import type { TokenSource } from "./types"

export interface ApplicationDefaultClient {
  readonly credentials: {
    access_token?: string | null
    expiry_date?: number | null
  }
  getRequestHeaders(): Promise<Headers>
}

export type ApplicationDefaultClientLoader = (
  scopes: readonly string[]
) => Promise<ApplicationDefaultClient>

export function createApplicationDefaultTokenSource(
  scopes: readonly string[],
  loadClient: ApplicationDefaultClientLoader = loadApplicationDefaultClient
): TokenSource {
  let clientPromise: Promise<ApplicationDefaultClient> | null = null
  let inflightHeaders: Promise<Headers> | null = null
  let invalidated = false

  const client = (): Promise<ApplicationDefaultClient> => {
    clientPromise ??= Promise.resolve()
      .then(() => loadClient(scopes))
      .catch((error: unknown) => {
        clientPromise = null
        throw wrapAuthError("could not load Application Default Credentials", error)
      })
    return clientPromise
  }

  const resolveHeaders = async (): Promise<Headers> => {
    const authClient = await client()
    if (invalidated) {
      // Preserve refresh credentials while forcing the official client to mint a new access token.
      authClient.credentials.access_token = null
      authClient.credentials.expiry_date = 0
      invalidated = false
    }

    try {
      return await authClient.getRequestHeaders()
    } catch (error) {
      throw wrapAuthError("could not obtain ADC request headers", error)
    }
  }

  const requestHeaders = (): Promise<Headers> => {
    inflightHeaders ??= resolveHeaders().finally(() => {
      inflightHeaders = null
    })
    return inflightHeaders
  }

  return {
    async get() {
      return extractBearerToken(await requestHeaders())
    },
    getRequestHeaders: requestHeaders,
    invalidate() {
      invalidated = true
    },
  }
}

function extractBearerToken(headers: Headers): string {
  const authorization = headers.get("authorization")
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]
  if (!token?.trim()) {
    throw googleAuthError(
      "Application Default Credentials did not return a bearer Authorization header."
    )
  }
  return token
}

async function loadApplicationDefaultClient(
  scopes: readonly string[]
): Promise<ApplicationDefaultClient> {
  const auth = new GoogleAuth({ scopes: [...scopes] })
  return auth.getClient()
}

function wrapAuthError(message: string, cause: unknown): SixbError {
  if (isSixbError(cause, "connector.unauthorized")) {
    return cause
  }
  const detail = cause instanceof Error ? cause.message : String(cause)
  return googleAuthError(`${message}: ${detail}`, { cause })
}
