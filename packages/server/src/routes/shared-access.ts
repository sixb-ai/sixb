import { GUEST_NAME_MAX_LENGTH, type SharedSessionContext } from "@sixb/core/internal/shares"
import type { Elysia } from "elysia"
import { CSRF_TOKEN_RESPONSE_HEADER_NAME } from "../auth/csrf"
import {
  type SharedAccessBoundary,
  sharedAccessForbiddenResponse,
  sharedAccessSecurityHeaders,
  sharedAccessUnauthenticatedResponse,
  sharedAccessUnavailableResponse,
  sharedBoundaryJsonResponse,
} from "../auth/shared-access"
import { SIXB_CSRF_SECURITY_SCHEME_ID } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ExchangeSharedAccessBodySchema,
  SetSharedAccessGuestNameBodySchema,
  SharedAccessGrantParamsSchema,
  SharedAccessSessionResponseSchema,
  SharedAccessSignOutResponseSchema,
} from "../schemas/shared-access"

export function registerSharedAccessRoutes(app: Elysia, boundary: SharedAccessBoundary) {
  return app
    .post(
      "/api/shared-access/:grantId/exchange",
      async ({ body, params, request }) => {
        try {
          const resolved = await boundary.exchange(request, params.grantId, body.secret)
          if (!resolved) return sharedAccessUnauthenticatedResponse()
          return sharedSessionResponse(resolved.context, resolved.cookies)
        } catch {
          return sharedAccessUnavailableResponse()
        }
      },
      {
        params: SharedAccessGrantParamsSchema,
        body: ExchangeSharedAccessBodySchema,
        response: {
          200: SharedAccessSessionResponseSchema,
          401: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
        error: sharedAccessRouteError,
        detail: {
          summary: "Exchange a shared link for a short-lived session",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "exchangeSharedAccess",
          security: [],
        },
      }
    )
    .get(
      "/api/shared-access/:grantId/session",
      async ({ params, request }) => {
        try {
          const resolved = await boundary.resolveSession(request, params.grantId)
          if (!resolved) {
            return withSetCookies(
              sharedAccessUnauthenticatedResponse(),
              boundary.clearCookieHeaders(request, params.grantId)
            )
          }
          return sharedSessionResponse(resolved.context, resolved.cookies)
        } catch {
          return sharedAccessUnavailableResponse()
        }
      },
      {
        params: SharedAccessGrantParamsSchema,
        response: {
          200: SharedAccessSessionResponseSchema,
          401: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
        error: sharedAccessRouteError,
        detail: {
          summary: "Get the current shared-access session",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "getSharedAccessSession",
          security: [],
        },
      }
    )
    .put(
      "/api/shared-access/:grantId/name",
      async ({ body, params, request }) => {
        try {
          const result = await boundary.setGuestName(request, params.grantId, body.name)
          switch (result.kind) {
            case "csrf":
              return sharedAccessForbiddenResponse()
            case "invalid":
              return withSetCookies(sharedAccessUnauthenticatedResponse(), result.setCookies)
            case "unnamed":
              return sharedBoundaryJsonResponse(
                {
                  error: `A name holds 1 to ${GUEST_NAME_MAX_LENGTH} characters on one line.`,
                  code: "invalid_name",
                },
                400
              )
            case "named":
              return sharedSessionResponse(result.context, result.cookies)
          }
        } catch {
          return sharedAccessUnavailableResponse()
        }
      },
      {
        params: SharedAccessGrantParamsSchema,
        body: SetSharedAccessGuestNameBodySchema,
        response: {
          200: SharedAccessSessionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
        error: sharedAccessRouteError,
        detail: {
          summary: "Name a shared-access session's visitor",
          description:
            "The visitor of a shared link has no account: they give their name once, and their comments and live presence carry it, marked as a guest's. Giving it again replaces it for what comes next; comments keep the name they were written under.",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "setSharedAccessGuestName",
          // Public to the auth guard, as sign-out is: the session cookie the path's grant names,
          // and its CSRF token, are checked here.
          security: [{ [SIXB_CSRF_SECURITY_SCHEME_ID]: [] }, {}],
        },
      }
    )
    .post(
      "/api/shared-access/:grantId/sign-out",
      async ({ params, request }) => {
        try {
          const result = await boundary.signOut(request, params.grantId)
          if (result.kind === "csrf") return sharedAccessForbiddenResponse()
          if (result.kind === "invalid") {
            return withSetCookies(sharedAccessUnauthenticatedResponse(), result.setCookies)
          }

          const response = new Response(JSON.stringify({ signedOut: true }), {
            status: 200,
            headers: sharedAccessSecurityHeaders(),
          })
          return withSetCookies(response, result.setCookies)
        } catch {
          return sharedAccessUnavailableResponse()
        }
      },
      {
        params: SharedAccessGrantParamsSchema,
        response: {
          200: SharedAccessSignOutResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
        error: sharedAccessRouteError,
        detail: {
          summary: "Sign out a shared-access session",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "signOutSharedAccess",
          // Succeeds for anyone; a Share's session cookie also needs its CSRF token.
          security: [{ [SIXB_CSRF_SECURITY_SCHEME_ID]: [] }, {}],
        },
      }
    )
}

function sharedSessionResponse(
  context: SharedSessionContext,
  cookies: { readonly setCookies: readonly string[]; readonly csrfToken: string }
): Response {
  const headers = sharedAccessSecurityHeaders()
  headers.set(CSRF_TOKEN_RESPONSE_HEADER_NAME, cookies.csrfToken)
  for (const cookie of cookies.setCookies) headers.append("set-cookie", cookie)
  return new Response(
    JSON.stringify({
      grantId: context.grantId,
      destinationPath: context.destinationPath,
      expiresAt: context.expiresAt.toISOString(),
      absoluteExpiresAt: context.absoluteExpiresAt.toISOString(),
      csrfToken: cookies.csrfToken,
      guestId: context.sessionId,
      ...(context.guestName === undefined ? {} : { guestName: context.guestName }),
    }),
    { status: 200, headers }
  )
}

function withSetCookies(response: Response, setCookies: readonly string[]): Response {
  for (const cookie of setCookies) response.headers.append("set-cookie", cookie)
  return response
}

function sharedAccessRouteError(context: {
  readonly code: unknown
  readonly error: unknown
}): Response {
  if (context.code === "PARSE" || isRequestValidationError(context)) {
    return sharedAccessUnauthenticatedResponse()
  }
  return sharedAccessUnavailableResponse()
}

function isRequestValidationError(context: {
  readonly code: unknown
  readonly error: unknown
}): boolean {
  if (context.code !== "VALIDATION" || !isRecord(context.error)) return false
  return ["body", "params", "query", "headers", "cookie"].includes(String(context.error.type))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
