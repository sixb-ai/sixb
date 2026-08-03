import { isSixbError } from "@sixb/core/errors"
import { googleAuthError, isRecord } from "../errors"
import type { ServiceAccountKey, TokenSource } from "./types"

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
const ASSERTION_LIFETIME_SEC = 3600
/** Refresh this long before the token's real expiry, to absorb clock skew and latency. */
const EXPIRY_MARGIN_MS = 60_000
/** Attempts for the token exchange itself (network / 429 / 5xx), independent of API retries. */
const EXCHANGE_MAX_ATTEMPTS = 3

interface TokenExchangeResult {
  readonly accessToken: string
  readonly expiresInSec: number
}

export interface ServiceAccountTokenSourceDeps {
  readonly now?: () => number
  readonly exchange?: (nowMs: number) => Promise<TokenExchangeResult>
}

export function createServiceAccountTokenSource(
  keyInput: string | ServiceAccountKey,
  scopes: readonly string[],
  subject: string | undefined,
  deps: ServiceAccountTokenSourceDeps = {}
): TokenSource {
  const key = normalizeKey(keyInput)
  const now = deps.now ?? (() => Date.now())
  const exchange = deps.exchange ?? ((nowMs: number) => exchangeToken(key, scopes, subject, nowMs))

  let cached: { token: string; expEpochMs: number } | null = null
  let inflight: Promise<string> | null = null

  const get = (): Promise<string> => {
    if (cached && cached.expEpochMs - EXPIRY_MARGIN_MS > now()) {
      return Promise.resolve(cached.token)
    }
    // Coalesce concurrent refreshes: N callers with an expired token trigger ONE exchange.
    inflight ??= refresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  const refresh = async (): Promise<string> => {
    const { accessToken, expiresInSec } = await exchange(now())
    cached = { token: accessToken, expEpochMs: now() + expiresInSec * 1000 }
    return accessToken
  }

  return {
    get,
    async getRequestHeaders() {
      return new Headers({ Authorization: `Bearer ${await get()}` })
    },
    invalidate() {
      cached = null
    },
  }
}

async function exchangeToken(
  key: ServiceAccountKey,
  scopes: readonly string[],
  subject: string | undefined,
  nowMs: number
): Promise<TokenExchangeResult> {
  const endpoint = key.token_uri ?? TOKEN_ENDPOINT
  const assertion = await signJwt(key, scopes, subject, endpoint, nowMs)
  const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion })

  let lastError: unknown = null
  for (let attempt = 0; attempt < EXCHANGE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000))
    }

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    } catch (error) {
      lastError = error
      continue
    }

    const payload = await readJsonSafe(response)
    if (response.ok) {
      const accessToken = isRecord(payload) ? payload.access_token : undefined
      const expiresIn = isRecord(payload) ? payload.expires_in : undefined
      if (typeof accessToken === "string" && typeof expiresIn === "number") {
        return { accessToken, expiresInSec: expiresIn }
      }
      throw googleAuthError("token endpoint returned an unexpected response shape.")
    }

    // 4xx (bad grant, malformed key, revoked) is terminal; only retry 429 / 5xx.
    if (response.status !== 429 && response.status < 500) {
      throw googleAuthError(describeTokenError(response.status, payload))
    }
    lastError = googleAuthError(describeTokenError(response.status, payload))
  }

  if (isSixbError(lastError, "connector.unauthorized")) {
    throw lastError
  }
  throw googleAuthError(
    `token exchange failed after ${EXCHANGE_MAX_ATTEMPTS} attempts: ${String(lastError)}`
  )
}

async function signJwt(
  key: ServiceAccountKey,
  scopes: readonly string[],
  subject: string | undefined,
  audience: string,
  nowMs: number
): Promise<string> {
  const iat = Math.floor(nowMs / 1000)
  const header = { alg: "RS256", typ: "JWT" }
  const claims = {
    iss: key.client_email,
    scope: scopes.join(" "),
    aud: audience,
    iat,
    exp: iat + ASSERTION_LIFETIME_SEC,
    ...(subject ? { sub: subject } : {}),
  }

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const cryptoKey = await importPrivateKey(key.private_key)
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64url(signature)}`
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    )
  } catch (error) {
    throw googleAuthError(`service account private_key is not a valid PKCS#8 PEM: ${String(error)}`)
  }
}

function normalizeKey(input: string | ServiceAccountKey): ServiceAccountKey {
  const key = typeof input === "string" ? parseKey(input) : input
  if (!key.client_email || !key.private_key) {
    throw googleAuthError("serviceAccountKey must include client_email and private_key.")
  }
  return key
}

function parseKey(raw: string): ServiceAccountKey {
  try {
    return JSON.parse(raw) as ServiceAccountKey
  } catch {
    throw googleAuthError("serviceAccountKey string must be valid JSON.")
  }
}

function describeTokenError(status: number, payload: unknown): string {
  const detail = isRecord(payload) ? formatOAuthError(payload) : null
  return detail
    ? `token exchange failed with ${status}: ${detail}`
    : `token exchange failed with ${status}.`
}

function formatOAuthError(payload: Record<string, unknown>): string | null {
  const error = payload.error
  if (typeof error !== "string") {
    return null
  }
  const description = payload.error_description
  return typeof description === "string" ? `${error}: ${description}` : error
}

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "")
  if (!body) {
    throw googleAuthError("service account private_key is empty.")
  }
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
