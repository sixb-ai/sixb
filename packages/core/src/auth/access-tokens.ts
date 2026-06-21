import { createHash, randomBytes, randomUUID } from "node:crypto"

export const PERSONAL_ACCESS_TOKEN_PREFIX = "sixb_pat"
export const SERVICE_ACCOUNT_ACCESS_TOKEN_PREFIX = "sixb_sat"

// The token prefix makes credentials self-identifying for operators and logs.
// Validity, revocation, expiration, and permissions still come from storage.
export type AccessTokenKind = "personal" | "serviceAccount"

export interface AccessTokenParts {
  readonly kind: AccessTokenKind
  readonly tokenId: string
  readonly tokenSecret: string
}

export interface AccessTokenCredential extends AccessTokenParts {
  readonly tokenHash: string
  readonly tokenValue: string
}

const ACCESS_TOKEN_ID_PATTERN = /^tok_[A-Za-z0-9_-]+$/
const ACCESS_TOKEN_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,}$/

export function generateAccessTokenSecret(): string {
  return randomBytes(32).toString("base64url")
}

export function hashAccessTokenSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

export function formatAccessTokenValue(
  kind: AccessTokenKind,
  tokenId: string,
  tokenSecret: string
): string {
  const prefix = accessTokenPrefixForKind(kind)

  if (!ACCESS_TOKEN_ID_PATTERN.test(tokenId)) {
    throw new Error("[Sixb] Access token ids must start with 'tok_' and be URL-safe.")
  }

  if (!ACCESS_TOKEN_SECRET_PATTERN.test(tokenSecret)) {
    throw new Error("[Sixb] Access token secrets must be at least 32 URL-safe characters.")
  }

  return `${prefix}_${tokenId}.${tokenSecret}`
}

export function parseAccessTokenValue(value: string | undefined): AccessTokenParts | null {
  // Parsing is intentionally non-throwing so auth paths can treat malformed
  // credentials exactly like missing credentials.
  if (!value) {
    return null
  }

  const firstDot = value.indexOf(".")
  if (firstDot <= 0 || firstDot !== value.lastIndexOf(".") || firstDot === value.length - 1) {
    return null
  }

  const tokenLabel = value.slice(0, firstDot)
  const tokenSecret = value.slice(firstDot + 1)
  const kind = accessTokenKindFromLabel(tokenLabel)
  if (!kind || !ACCESS_TOKEN_SECRET_PATTERN.test(tokenSecret)) {
    return null
  }

  const tokenId = tokenLabel.slice(`${accessTokenPrefixForKind(kind)}_`.length)
  if (!ACCESS_TOKEN_ID_PATTERN.test(tokenId)) {
    return null
  }

  return { kind, tokenId, tokenSecret }
}

export function getBearerAccessTokenValue(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) {
    return null
  }

  const [scheme, token, extra] = header.trim().split(/\s+/)
  if (scheme?.toLowerCase() !== "bearer" || !token || extra) {
    return null
  }

  return token
}

export function createAccessTokenCredential(
  kind: AccessTokenKind,
  tokenId = `tok_${randomUUID()}`
): AccessTokenCredential {
  const tokenSecret = generateAccessTokenSecret()
  // Callers should return tokenValue once, then persist only tokenHash.
  return {
    kind,
    tokenId,
    tokenSecret,
    tokenHash: hashAccessTokenSecret(tokenSecret),
    tokenValue: formatAccessTokenValue(kind, tokenId, tokenSecret),
  }
}

function accessTokenPrefixForKind(kind: AccessTokenKind): string {
  switch (kind) {
    case "personal":
      return PERSONAL_ACCESS_TOKEN_PREFIX
    case "serviceAccount":
      return SERVICE_ACCOUNT_ACCESS_TOKEN_PREFIX
  }
}

function accessTokenKindFromLabel(label: string): AccessTokenKind | null {
  if (label.startsWith(`${PERSONAL_ACCESS_TOKEN_PREFIX}_`)) {
    return "personal"
  }

  if (label.startsWith(`${SERVICE_ACCOUNT_ACCESS_TOKEN_PREFIX}_`)) {
    return "serviceAccount"
  }

  return null
}
