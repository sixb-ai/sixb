import {
  type AuthenticatedAuthSession,
  createCsrfCookieHeader,
  createSessionCookieHeader,
  generateCsrfToken,
  getCookie,
  type OntologySource,
  type Sixb,
} from "@sixb/core"

export function createSessionRenewalCookieHeaders(input: {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly request: Request
  readonly session: AuthenticatedAuthSession
  readonly csrfToken?: string
}): { readonly csrfToken: string; readonly headers: readonly [string, string] } | null {
  const cookieOptions = input.sixb.auth.getCookieOptions({
    audience: input.session.session.audience,
  })
  const sessionValue = getCookie(input.request, cookieOptions.sessionCookieName)
  if (!sessionValue) {
    return null
  }

  const csrfToken =
    input.csrfToken ?? getCookie(input.request, cookieOptions.csrfCookieName) ?? generateCsrfToken()
  return {
    csrfToken,
    headers: [
      createSessionCookieHeader({
        request: input.request,
        value: sessionValue,
        expiresAt: input.session.session.expiresAt,
        options: cookieOptions,
      }),
      createCsrfCookieHeader({
        request: input.request,
        value: csrfToken,
        expiresAt: input.session.session.expiresAt,
        options: cookieOptions,
      }),
    ],
  }
}
