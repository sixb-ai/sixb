import { OidcAuthError } from "./errors"

export type OidcClaims = Readonly<Record<string, unknown>>

export interface ResolvedOidcProfile {
  readonly subject: string
  readonly email: string
  readonly emailVerified: boolean
  readonly displayName?: string
  readonly avatarUrl?: string
  readonly claims: OidcClaims
  readonly nonce?: string
}

export function resolveOidcProfile(input: {
  readonly idTokenClaims: OidcClaims
  readonly userInfo?: OidcClaims
}): ResolvedOidcProfile {
  const subject = claimString(input.idTokenClaims, "sub")
  if (!subject) {
    throw new OidcAuthError("OIDC id token is missing a subject.")
  }

  const userInfoSubject = input.userInfo ? claimString(input.userInfo, "sub") : undefined
  if (userInfoSubject && userInfoSubject !== subject) {
    throw new OidcAuthError("OIDC userinfo subject does not match the id token subject.")
  }

  const email =
    (input.userInfo ? claimString(input.userInfo, "email") : undefined) ??
    claimString(input.idTokenClaims, "email")
  if (!email) {
    throw new OidcAuthError("OIDC claims are missing an email.")
  }

  const emailVerified =
    (input.userInfo ? claimBoolean(input.userInfo, "email_verified") : undefined) ??
    claimBoolean(input.idTokenClaims, "email_verified") ??
    false

  const displayName =
    (input.userInfo ? claimString(input.userInfo, "name") : undefined) ??
    claimString(input.idTokenClaims, "name")
  const avatarUrl =
    (input.userInfo ? claimString(input.userInfo, "picture") : undefined) ??
    claimString(input.idTokenClaims, "picture")

  return {
    subject,
    email,
    emailVerified,
    displayName,
    avatarUrl,
    nonce: claimString(input.idTokenClaims, "nonce"),
    claims: input.userInfo
      ? {
          idToken: input.idTokenClaims,
          userInfo: input.userInfo,
        }
      : input.idTokenClaims,
  }
}

function claimString(claims: OidcClaims, key: string): string | undefined {
  const value = claims[key]
  if (typeof value !== "string") {
    return undefined
  }
  const normalized = value.trim()
  return normalized || undefined
}

function claimBoolean(claims: OidcClaims, key: string): boolean | undefined {
  const value = claims[key]
  return typeof value === "boolean" ? value : undefined
}
