import {
  AuthRuntimeError,
  type AuthSessionAudience,
  type AuthStorage,
  AuthStorageError,
  clearCsrfCookieHeader,
  clearSessionCookieHeader,
  createCsrfCookieHeader,
  createSessionCookieHeader,
  createSessionCredential,
  generateCsrfToken,
  getCookie,
  type InvitationRecord,
  isMagicLinkAuthStrategy,
  isOidcAuthStrategy,
  type OntologySource,
  type Pario,
  verifyDoubleSubmitCsrf,
} from "@pario/core"
import { type Elysia, t } from "elysia"
import type { ResolveRequestAuthContext } from "../auth/browser-origin"
import { sanitizeReturnTo } from "../auth/return-to"
import { PARIO_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import {
  AuthSessionResponseSchema,
  AuthSignOutResponseSchema,
  CreateAuthInvitationBodySchema,
  CreateAuthInvitationResponseSchema,
  ListAuthInvitationsQuerySchema,
  ListAuthInvitationsResponseSchema,
  RevokeAuthInvitationParamsSchema,
  RevokeAuthInvitationResponseSchema,
} from "../schemas/auth"
import { ErrorResponseSchema } from "../schemas/common"
import { parseDate, parseOptionalInt, toIsoString } from "../utils/http"

type ResolvedCookieOptions = Parameters<typeof createCsrfCookieHeader>[0]["options"]
type AuthenticatedAuthSessionResponse = {
  readonly authenticated: true
  readonly csrfToken: string
  readonly user: {
    readonly id: string
    readonly email: string
    readonly displayName?: string
    readonly avatarUrl?: string
    readonly groupIds: readonly string[]
  }
  readonly session: {
    readonly id: string
    readonly expiresAt: string
  }
}

export interface AuthRoutesOptions {
  readonly resolveAuthContext: ResolveRequestAuthContext
}

export function registerAuthRoutes(
  app: Elysia,
  pario: Pario<readonly OntologySource[]>,
  options: AuthRoutesOptions
) {
  return app
    .get(
      "/api/auth/session",
      async ({ request }) => {
        const authOptions = resolveAuthOptions(options, request)
        const session = await pario.auth.getSession(request, authOptions)
        if (!session.authenticated) {
          return jsonResponse({ authenticated: false as const }, 200)
        }

        const cookieOptions = pario.auth.getCookieOptions(authOptions)
        const csrf = resolveSessionCsrfToken({ pario, request, cookieOptions })
        return authSessionJsonResponse(
          {
            authenticated: true as const,
            csrfToken: csrf.token,
            user: {
              id: session.user.id,
              email: session.user.email,
              displayName: session.user.displayName,
              avatarUrl: session.user.avatarUrl,
              groupIds: [...session.groupIds],
            },
            session: {
              id: session.session.id,
              expiresAt: toIsoString(session.session.expiresAt),
            },
          },
          csrf.setCookie
        )
      },
      {
        response: { 200: AuthSessionResponseSchema },
        detail: {
          summary: "Get current auth session",
          tags: ["Auth"],
          operationId: "getAuthSession",
        },
      }
    )
    .post(
      "/api/auth/sign-out",
      async ({ request }) => {
        const authOptions = resolveAuthOptions(options, request)
        const session = await pario.auth.getSession(request, authOptions)
        const cookieOptions = pario.auth.getCookieOptions(authOptions)
        if (
          session.authenticated &&
          !verifyDoubleSubmitCsrf(request, {
            cookieName: cookieOptions.csrfCookieName,
          })
        ) {
          return jsonResponse({ error: "CSRF verification failed" }, 403)
        }

        if (session.authenticated) {
          await pario.storage.auth?.sessions.revoke({
            projectId: pario.id,
            id: session.session.id,
            revokedAt: new Date(),
          })
        }

        const headers = new Headers({ "content-type": "application/json; charset=utf-8" })
        headers.append("set-cookie", clearSessionCookieHeader({ request, options: cookieOptions }))
        headers.append("set-cookie", clearCsrfCookieHeader({ request, options: cookieOptions }))

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers,
        })
      },
      {
        response: {
          200: AuthSignOutResponseSchema,
          403: ErrorResponseSchema,
        },
        detail: {
          summary: "Sign out current auth session",
          tags: ["Auth"],
          operationId: "signOut",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/auth/invitations",
      async ({ request, body }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = CreateAuthInvitationBodySchema.parse(body)
          const result = await pario.auth.invite(
            request,
            {
              email: parsed.email,
              groupIds: parsed.groupIds,
              expiresAt: parseDate(parsed.expiresAt),
              returnTo: parsed.returnTo,
            },
            authOptions
          )

          return jsonResponse(
            {
              invitation: serializeInvitation(result.invitation),
              delivery: result.delivery,
            },
            201
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        body: CreateAuthInvitationBodySchema,
        response: {
          201: CreateAuthInvitationResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Create an auth invitation",
          tags: ["Auth"],
          operationId: "createAuthInvitation",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/auth/invitations",
      async ({ request, query }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = ListAuthInvitationsQuerySchema.parse(query)
          const result = await pario.auth.listInvitations(
            request,
            {
              email: parsed.email,
              statuses: parsed.status ? [parsed.status] : undefined,
              limit: parseOptionalInt(parsed.limit),
              offset: parseOptionalInt(parsed.offset),
              order: parsed.order,
            },
            authOptions
          )

          return jsonResponse(
            {
              invitations: result.invitations.map(serializeInvitation),
              hasMore: result.hasMore,
              total: result.total,
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        query: ListAuthInvitationsQuerySchema,
        response: {
          200: ListAuthInvitationsResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "List auth invitations",
          tags: ["Auth"],
          operationId: "listAuthInvitations",
        },
      }
    )
    .post(
      "/api/auth/invitations/:invitationId/revoke",
      async ({ request, params }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = RevokeAuthInvitationParamsSchema.parse(params)
          const result = await pario.auth.revokeInvitation(
            request,
            {
              invitationId: parsed.invitationId,
            },
            authOptions
          )

          return jsonResponse(
            {
              invitation: serializeInvitation(result.invitation),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: RevokeAuthInvitationParamsSchema,
        response: {
          200: RevokeAuthInvitationResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Revoke an auth invitation",
          tags: ["Auth"],
          operationId: "revokeAuthInvitation",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/auth/sign-in",
      async ({ body, request }) => {
        const strategy = pario.auth.getStrategy()
        const returnTo = sanitizeReturnTo(body.returnTo)
        const authStorage = requireAuthStorage(pario)

        if (isMagicLinkAuthStrategy(strategy)) {
          await strategy.requestMagicLink({
            projectId: pario.id,
            authStorage,
            email: body.email ?? "",
            returnTo,
            requestOrigin: new URL(request.url).origin,
          })

          return htmlMessageResponse("If this email can sign in, we sent a link.")
        }

        if (isOidcAuthStrategy(strategy)) {
          const result = await strategy.startOidcSignIn({
            projectId: pario.id,
            authStorage,
            returnTo,
            requestOrigin: new URL(request.url).origin,
          })
          return redirectResponse(result.redirectTo)
        }

        return strategyNotImplementedResponse("Sign-in is not implemented yet.")
      },
      {
        body: t.Object({
          email: t.Optional(t.String()),
          returnTo: t.Optional(t.String()),
        }),
        parse: "urlencoded",
        detail: { hide: true },
      }
    )
    .get(
      "/auth/sign-in",
      async ({ request }) => {
        const strategy = pario.auth.getStrategy()
        const url = new URL(request.url)
        const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"))

        if (isMagicLinkAuthStrategy(strategy)) {
          return signInFormResponse(returnTo)
        }

        if (isOidcAuthStrategy(strategy)) {
          const result = await strategy.startOidcSignIn({
            projectId: pario.id,
            authStorage: requireAuthStorage(pario),
            returnTo,
            requestOrigin: url.origin,
          })
          return redirectResponse(result.redirectTo)
        }

        return strategyNotImplementedResponse("Sign-in is not implemented yet.")
      },
      { detail: { hide: true } }
    )
    .get(
      "/auth/callback",
      async ({ request }) => {
        const strategy = pario.auth.getStrategy()
        const now = new Date()
        const sessionCredential = createSessionCredential()

        if (isMagicLinkAuthStrategy(strategy)) {
          const authOptions = resolveAuthOptions(options, request)
          const url = new URL(request.url)
          const magicLinkId = url.searchParams.get("magicLinkId")?.trim()
          const token = url.searchParams.get("token")?.trim()
          const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"))

          if (!magicLinkId || !token) {
            return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
          }

          try {
            await strategy.completeMagicLinkSignIn({
              projectId: pario.id,
              authStorage: requireAuthStorage(pario),
              magicLinkId,
              token,
              session: {
                id: sessionCredential.sessionId,
                audience: authOptions.audience,
                tokenHash: sessionCredential.tokenHash,
                createdAt: now,
                expiresAt: new Date(now.getTime() + pario.auth.getSessionTtlMs()),
              },
            })
          } catch {
            return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
          }

          return sessionCallbackCompletionResponse({
            pario,
            request,
            sessionCredential,
            audience: authOptions.audience,
            returnTo,
          })
        }

        if (isOidcAuthStrategy(strategy)) {
          try {
            const authOptions = resolveAuthOptions(options, request)
            const result = await strategy.completeOidcSignIn({
              projectId: pario.id,
              authStorage: requireAuthStorage(pario),
              requestUrl: request.url,
              requestOrigin: new URL(request.url).origin,
              session: {
                id: sessionCredential.sessionId,
                audience: authOptions.audience,
                tokenHash: sessionCredential.tokenHash,
                createdAt: now,
                expiresAt: new Date(now.getTime() + pario.auth.getSessionTtlMs()),
              },
            })

            return sessionCallbackCompletionResponse({
              pario,
              request,
              sessionCredential,
              audience: authOptions.audience,
              returnTo: result.returnTo,
            })
          } catch (error) {
            logAuthCallbackError("OIDC", error)
            return htmlMessageResponse("This sign-in attempt could not be completed.", 400)
          }
        }

        return strategyNotImplementedResponse("Auth callback is not implemented yet.")
      },
      { detail: { hide: true } }
    )
}

function sessionCallbackCompletionResponse(input: {
  readonly pario: Pario<readonly OntologySource[]>
  readonly request: Request
  readonly sessionCredential: ReturnType<typeof createSessionCredential>
  readonly audience: AuthSessionAudience
  readonly returnTo: string
}): Response {
  const cookieOptions = input.pario.auth.getCookieOptions({ audience: input.audience })
  const headers = new Headers({
    "cache-control": "no-store",
  })
  headers.append(
    "set-cookie",
    createSessionCookieHeader({
      request: input.request,
      value: input.sessionCredential.cookieValue,
      maxAgeSeconds: Math.trunc(input.pario.auth.getSessionTtlMs() / 1000),
      options: cookieOptions,
    })
  )
  headers.append(
    "set-cookie",
    createCsrfCookieHeader({
      request: input.request,
      value: generateCsrfToken(),
      maxAgeSeconds: Math.trunc(input.pario.auth.getSessionTtlMs() / 1000),
      options: cookieOptions,
    })
  )

  return authCallbackCompletionResponse(input.returnTo, headers)
}

// OAuth and magic-link callbacks arrive from a cross-site navigation. A direct 3xx after
// setting SameSite=Strict cookies can keep the next request in that cross-site redirect
// chain. Finish on a Pario document first, then navigate to the sanitized return path.
function authCallbackCompletionResponse(returnTo: string, headers: Headers): Response {
  headers.set("content-type", "text/html; charset=utf-8")
  headers.set(
    "content-security-policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; navigate-to 'self'"
  )
  headers.set("referrer-policy", "no-referrer")
  headers.set("x-content-type-options", "nosniff")

  return new Response(
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="referrer" content="no-referrer">',
      `<meta http-equiv="refresh" content="0;url=${escapeHtml(returnTo)}">`,
      "<title>Signing in</title>",
      "</head>",
      "<body>",
      "<main>",
      "<p>Signing you in...</p>",
      `<p><a href="${escapeHtml(returnTo)}">Continue</a></p>`,
      "</main>",
      "</body>",
      "</html>",
    ].join(""),
    {
      status: 200,
      headers,
    }
  )
}

function resolveAuthOptions(
  options: AuthRoutesOptions,
  request: Request
): {
  readonly audience: AuthSessionAudience
} {
  return { audience: options.resolveAuthContext(request).audience }
}

function resolveSessionCsrfToken(input: {
  readonly pario: Pario<readonly OntologySource[]>
  readonly request: Request
  readonly cookieOptions: ResolvedCookieOptions
}): { readonly token: string; readonly setCookie?: string } {
  const existing = getCookie(input.request, input.cookieOptions.csrfCookieName)
  if (existing) {
    return { token: existing }
  }

  const token = generateCsrfToken()
  return {
    token,
    setCookie: createCsrfCookieHeader({
      request: input.request,
      value: token,
      maxAgeSeconds: Math.trunc(input.pario.auth.getSessionTtlMs() / 1000),
      options: input.cookieOptions,
    }),
  }
}

function authSessionJsonResponse(
  body: AuthenticatedAuthSessionResponse,
  csrfSetCookie: string | undefined
): Response {
  if (!csrfSetCookie) {
    return jsonResponse(body, 200)
  }

  const headers = new Headers({ "content-type": "application/json; charset=utf-8" })
  headers.append("set-cookie", csrfSetCookie)
  return jsonResponse(body, 200, headers)
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
    },
  })
}

function strategyNotImplementedResponse(message: string): Response {
  return new Response(message, {
    status: 501,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function signInFormResponse(returnTo: string): Response {
  return new Response(
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>Sign in</title>",
      "</head>",
      "<body>",
      '<main style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem;">',
      "<h1>Sign in</h1>",
      '<form method="post" action="/auth/sign-in">',
      `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">`,
      '<label for="email">Email</label>',
      '<input id="email" name="email" type="email" autocomplete="email" required style="display: block; width: 100%; box-sizing: border-box; margin: 0.5rem 0 1rem; padding: 0.625rem;">',
      '<button type="submit">Send sign-in link</button>',
      "</form>",
      "</main>",
      "</body>",
      "</html>",
    ].join(""),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  )
}

function htmlMessageResponse(message: string, status = 200): Response {
  return new Response(
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>Sign in</title>",
      "</head>",
      "<body>",
      '<main style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem;">',
      `<p>${escapeHtml(message)}</p>`,
      "</main>",
      "</body>",
      "</html>",
    ].join(""),
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  )
}

function requireAuthStorage(pario: Pario<readonly OntologySource[]>): AuthStorage {
  if (!pario.storage.auth) {
    throw new Error("[ParioServer] Auth storage is required for auth routes.")
  }

  return pario.storage.auth
}

function serializeInvitation(invitation: InvitationRecord) {
  return {
    id: invitation.id,
    email: invitation.email,
    groupIds: [...invitation.groupIds],
    status: invitation.status,
    createdAt: toIsoString(invitation.createdAt),
    updatedAt: toIsoString(invitation.updatedAt),
    expiresAt: toIsoString(invitation.expiresAt),
    acceptedAt: invitation.acceptedAt ? toIsoString(invitation.acceptedAt) : undefined,
    revokedAt: invitation.revokedAt ? toIsoString(invitation.revokedAt) : undefined,
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function authRouteErrorResponse(error: unknown): Response {
  if (error instanceof AuthRuntimeError) {
    if (error.code === "authentication_required") {
      return jsonResponse({ error: error.message }, 401)
    }

    if (error.code === "authorization_denied") {
      return jsonResponse({ error: error.message }, 403)
    }

    if (error.code === "invalid_auth_input") {
      return jsonResponse({ error: error.message }, 400)
    }

    if (error.code === "rate_limited") {
      return jsonResponse({ error: error.message }, 429)
    }

    return jsonResponse({ error: error.message }, 500)
  }

  if (error instanceof AuthStorageError) {
    if (error.code === "missing_invitation") {
      return jsonResponse({ error: error.message }, 404)
    }

    return jsonResponse({ error: error.message }, 400)
  }

  if (error instanceof Error) {
    const status =
      error.message.startsWith("Invalid date:") || error.message.startsWith("Invalid integer:")
        ? 400
        : 500
    return jsonResponse({ error: error.message }, status)
  }

  return jsonResponse({ error: String(error) }, 500)
}

function logAuthCallbackError(kind: string, error: unknown): void {
  if (process.env.NODE_ENV !== "development" && process.env.PARIO_AUTH_DEBUG !== "1") {
    return
  }

  const detail =
    error instanceof AuthStorageError
      ? `${error.name}(${error.code}): ${error.message}`
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)

  console.error(`[ParioServer] ${kind} auth callback failed: ${detail}`)
}

function jsonResponse(body: unknown, status: number, headersInit?: HeadersInit): Response {
  const headers = new Headers(headersInit)
  headers.set("content-type", headers.get("content-type") ?? "application/json; charset=utf-8")
  headers.set("cache-control", headers.get("cache-control") ?? "no-store")

  return new Response(JSON.stringify(body), {
    status,
    headers,
  })
}
