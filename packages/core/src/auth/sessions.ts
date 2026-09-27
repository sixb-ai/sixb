import { createHash, randomBytes, randomUUID } from "node:crypto"

export interface SessionCookieParts {
  readonly sessionId: string
  readonly sessionSecret: string
}

export interface SessionCredential {
  readonly sessionId: string
  readonly sessionSecret: string
  readonly tokenHash: string
  readonly cookieValue: string
}

export function generateSessionSecret(): string {
  return randomBytes(32).toString("base64url")
}

export function hashSessionSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

export function formatSessionCookieValue(sessionId: string, sessionSecret: string): string {
  if (!sessionId || !sessionSecret || sessionId.includes(".") || sessionSecret.includes(".")) {
    throw new Error("[Sixb] Session cookie values must be non-empty and must not contain '.'.")
  }

  return `${sessionId}.${sessionSecret}`
}

export function parseSessionCookieValue(value: string | undefined): SessionCookieParts | null {
  if (!value) {
    return null
  }

  const firstDot = value.indexOf(".")
  if (firstDot <= 0 || firstDot !== value.lastIndexOf(".") || firstDot === value.length - 1) {
    return null
  }

  return {
    sessionId: value.slice(0, firstDot),
    sessionSecret: value.slice(firstDot + 1),
  }
}

export function createSessionCredential(sessionId = `ses_${randomUUID()}`): SessionCredential {
  const sessionSecret = generateSessionSecret()
  return {
    sessionId,
    sessionSecret,
    tokenHash: hashSessionSecret(sessionSecret),
    cookieValue: formatSessionCookieValue(sessionId, sessionSecret),
  }
}

export const SESSION_ACCESS_TOKEN_PREFIX = "sixb_at_"
export const SESSION_REFRESH_TOKEN_PREFIX = "sixb_rt_"

export interface BearerSessionTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly tokenHash: string
  readonly refreshTokenHash: string
}

/** Fresh access and refresh tokens for a native client's session. Only their hashes are stored. */
export function createBearerSessionTokens(sessionId: string): BearerSessionTokens {
  const accessSecret = generateSessionSecret()
  const refreshSecret = generateSessionSecret()
  return {
    accessToken: `${SESSION_ACCESS_TOKEN_PREFIX}${formatSessionCookieValue(sessionId, accessSecret)}`,
    refreshToken: `${SESSION_REFRESH_TOKEN_PREFIX}${formatSessionCookieValue(sessionId, refreshSecret)}`,
    tokenHash: hashSessionSecret(accessSecret),
    refreshTokenHash: hashSessionSecret(refreshSecret),
  }
}

/** The session id and secret in a bearer session token, or null when it is not one. */
export function parseBearerSessionToken(
  prefix: typeof SESSION_ACCESS_TOKEN_PREFIX | typeof SESSION_REFRESH_TOKEN_PREFIX,
  value: string
): SessionCookieParts | null {
  return value.startsWith(prefix) ? parseSessionCookieValue(value.slice(prefix.length)) : null
}
