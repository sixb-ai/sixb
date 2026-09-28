import { OidcAuthError } from "./errors"

/**
 * Claims about the signed-in user: the ID token's, merged over UserInfo's when UserInfo was
 * fetched. Standard claims are typed, and a standard claim with an unexpected type is dropped.
 */
export interface OidcClaims {
  readonly sub: string
  readonly email?: string
  /** True only when the provider sends `true`, or the string `"true"` some providers send. */
  readonly email_verified: boolean
  readonly preferred_username?: string
  readonly name?: string
  readonly picture?: string
  readonly [claim: string]: unknown
}

const STRING_CLAIMS = ["email", "preferred_username", "name", "picture"] as const

export function toOidcClaims(raw: Readonly<Record<string, unknown>>): OidcClaims {
  const claims: Record<string, unknown> = { ...raw }
  for (const key of ["sub", ...STRING_CLAIMS]) {
    const value = typeof raw[key] === "string" ? raw[key].trim() : ""
    claims[key] = value || undefined
  }
  const verified = raw.email_verified
  claims.email_verified = verified === true || verified === "true"

  if (!claims.sub) {
    throw new OidcAuthError("OIDC id token is missing a subject.")
  }
  return claims as OidcClaims
}

/** A verified `email`: what Google, Okta, Auth0, and Keycloak vouch with. */
export function verifiedEmail(claims: OidcClaims): string | undefined {
  return claims.email_verified ? claims.email : undefined
}
