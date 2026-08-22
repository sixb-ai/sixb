import { createHash } from "node:crypto"
import type { ConnectorAuthorizationRecord } from "../storage"
import { createConnectorCodedError } from "./errors"
import type { ConnectorAccountCandidate, ConnectorOAuthCredentials } from "./types"

type ConnectorValidationErrorCode =
  | "connector.adapter_invalid"
  | "connector.authorization_invalid"
  | "connector.configuration_invalid"

export function validateCredentials(
  credentials: ConnectorOAuthCredentials
): ConnectorOAuthCredentials {
  if (!isRecord(credentials)) {
    throw createConnectorCodedError(
      "connector.adapter_invalid",
      "OAuth connector adapter returned invalid credentials."
    )
  }

  const normalized: {
    accessToken: string
    refreshToken?: string
    tokenType?: string
    scopes?: string[]
    expiresAt?: Date
  } = {
    accessToken: nonblank(
      credentials.accessToken,
      "provider access token",
      "connector.adapter_invalid"
    ),
  }

  if (credentials.refreshToken !== undefined) {
    normalized.refreshToken = nonblank(
      credentials.refreshToken,
      "provider refresh token",
      "connector.adapter_invalid"
    )
  }

  if (credentials.tokenType !== undefined) {
    normalized.tokenType = nonblank(
      credentials.tokenType,
      "provider token type",
      "connector.adapter_invalid"
    )
  }

  if (credentials.scopes !== undefined) {
    if (!Array.isArray(credentials.scopes)) {
      throw createConnectorCodedError(
        "connector.adapter_invalid",
        "OAuth connector adapter returned invalid scopes."
      )
    }
    normalized.scopes = [
      ...new Set(
        credentials.scopes.map((scope) =>
          nonblank(scope, "provider scope", "connector.adapter_invalid")
        )
      ),
    ]
  }

  if (credentials.expiresAt !== undefined) {
    if (!(credentials.expiresAt instanceof Date) || Number.isNaN(credentials.expiresAt.getTime())) {
      throw createConnectorCodedError(
        "connector.adapter_invalid",
        "OAuth connector adapter returned an invalid token expiry."
      )
    }
    normalized.expiresAt = new Date(credentials.expiresAt)
  }

  return normalized
}

export function validateAccounts(
  accounts: readonly ConnectorAccountCandidate[]
): readonly ConnectorAccountCandidate[] {
  if (!Array.isArray(accounts)) {
    throw createConnectorCodedError(
      "connector.adapter_invalid",
      "OAuth connector adapter returned an invalid account list."
    )
  }
  const ids = new Set<string>()
  return accounts.map((account) => {
    if (!isRecord(account)) {
      throw createConnectorCodedError(
        "connector.adapter_invalid",
        "OAuth connector adapter returned an invalid account."
      )
    }
    const id = nonblank(account.id, "external account id", "connector.adapter_invalid")
    if (ids.has(id)) {
      throw createConnectorCodedError(
        "connector.adapter_invalid",
        `OAuth connector adapter returned duplicate account '${id}'.`
      )
    }
    ids.add(id)
    const description =
      account.description === undefined
        ? undefined
        : nonblank(account.description, "external account description", "connector.adapter_invalid")
    const avatarUrl =
      account.avatarUrl === undefined
        ? undefined
        : normalizedHttpUrl(
            nonblank(account.avatarUrl, "external account avatar URL", "connector.adapter_invalid"),
            "external account avatar URL",
            "connector.adapter_invalid"
          )
    return {
      id,
      label: nonblank(account.label, "external account label", "connector.adapter_invalid"),
      ...(description === undefined ? {} : { description }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
    }
  })
}

export function serializeCredentials(credentials: ConnectorOAuthCredentials): string {
  return JSON.stringify({
    version: 1,
    accessToken: credentials.accessToken,
    ...(credentials.refreshToken === undefined ? {} : { refreshToken: credentials.refreshToken }),
    ...(credentials.tokenType === undefined ? {} : { tokenType: credentials.tokenType }),
    ...(credentials.scopes === undefined ? {} : { scopes: credentials.scopes }),
    ...(credentials.expiresAt === undefined
      ? {}
      : { expiresAt: credentials.expiresAt.toISOString() }),
  })
}

export function parseCredentials(serialized: string): ConnectorOAuthCredentials {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch (error) {
    throw createConnectorCodedError(
      "connector.credentials_unavailable",
      "Stored connector credentials are invalid.",
      { cause: error }
    )
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.accessToken !== "string") {
    throw createConnectorCodedError(
      "connector.credentials_unavailable",
      "Stored connector credentials are invalid."
    )
  }
  if (
    (value.refreshToken !== undefined && typeof value.refreshToken !== "string") ||
    (value.tokenType !== undefined && typeof value.tokenType !== "string") ||
    (value.scopes !== undefined &&
      (!Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== "string"))) ||
    (value.expiresAt !== undefined && typeof value.expiresAt !== "string")
  ) {
    throw createConnectorCodedError(
      "connector.credentials_unavailable",
      "Stored connector credentials are invalid."
    )
  }
  const expiresAt = value.expiresAt === undefined ? undefined : new Date(value.expiresAt)
  try {
    return validateCredentials({
      accessToken: value.accessToken,
      ...(value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken }),
      ...(value.tokenType === undefined ? {} : { tokenType: value.tokenType }),
      ...(value.scopes === undefined ? {} : { scopes: value.scopes as string[] }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    })
  } catch (error) {
    throw createConnectorCodedError(
      "connector.credentials_unavailable",
      "Stored connector credentials are invalid.",
      { cause: error }
    )
  }
}

export function shouldRefresh(
  authorization: ConnectorAuthorizationRecord,
  now: Date,
  skewMs: number
): boolean {
  return (
    authorization.credentialExpiresAt !== undefined &&
    authorization.credentialExpiresAt.getTime() <= now.getTime() + skewMs
  )
}

export function tokenView(credentials: ConnectorOAuthCredentials) {
  return {
    accessToken: credentials.accessToken,
    ...(credentials.tokenType === undefined ? {} : { tokenType: credentials.tokenType }),
  }
}

export function parseAttemptId(state: string): string {
  const separator = state.indexOf(".")
  if (separator <= 0 || separator === state.length - 1) {
    throw createConnectorCodedError("connector.authorization_invalid", "OAuth state is invalid.")
  }
  return state.slice(0, separator)
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

export function normalizedHttpUrl(
  value: string | URL,
  field: string,
  code: ConnectorValidationErrorCode = "connector.configuration_invalid"
): string {
  let url: URL
  try {
    if (typeof value !== "string" && !(value instanceof URL)) throw new Error("invalid URL")
    url = new URL(value)
  } catch (error) {
    throw createConnectorCodedError(code, `${field} must be an absolute URL.`, { cause: error })
  }
  if (url.username || url.password) {
    throw createConnectorCodedError(code, `${field} must not contain credentials.`)
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw createConnectorCodedError(code, `${field} must use HTTPS, except on a loopback host.`)
  }
  return url.toString()
}

export function assertAuthorizationUrlParameters(
  authorizationUrl: string,
  expected: { readonly state: string; readonly codeChallenge: string }
): void {
  const parameters = new URL(authorizationUrl).searchParams
  if (
    !sameSingleParameter(parameters, "state", expected.state) ||
    !sameSingleParameter(parameters, "code_challenge", expected.codeChallenge) ||
    !sameSingleParameter(parameters, "code_challenge_method", "S256")
  ) {
    throw createConnectorCodedError(
      "connector.adapter_invalid",
      "OAuth connector authorization URL must preserve the framework-provided state and PKCE S256 parameters."
    )
  }
}

export function nonblank(
  value: unknown,
  field: string,
  code: ConnectorValidationErrorCode = "connector.configuration_invalid"
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw createConnectorCodedError(code, `${field} must be a non-empty string.`)
  }
  return value
}

export function positiveDuration(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      `Connector ${field} must be a positive duration.`
    )
  }
  return value
}

export function nonNegativeDuration(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      `Connector ${field} must not be negative.`
    )
  }
  return value
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort()
  const rightSorted = [...right].sort()
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  )
}

function sameSingleParameter(parameters: URLSearchParams, name: string, expected: string): boolean {
  const values = parameters.getAll(name)
  return values.length === 1 && values[0] === expected
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
