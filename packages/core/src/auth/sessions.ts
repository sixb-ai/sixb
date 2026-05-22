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
    throw new Error("[Pario] Session cookie values must be non-empty and must not contain '.'.")
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
