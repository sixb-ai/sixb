import type { SixbHostView } from "@sixb/core"
import type { SharedAccessSessionContext } from "@sixb/core/internal/shares"
import type { Elysia } from "elysia"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { codedErrorResponseSchema, ErrorResponseSchema } from "../schemas/common"
import {
  ExchangeSharedAccessBodySchema,
  SharedAccessContextSchema,
  SharedAccessGrantParamsSchema,
  SharedAccessSessionResponseSchema,
  SharedAccessSignOutResponseSchema,
} from "../schemas/shared-access"
import { SharedAccessGuard } from "../shared-access/guard"
import { createUnexpectedRouteError, toIsoString } from "../utils/http"

const SharedAccessUnavailableErrorResponseSchema = codedErrorResponseSchema([
  "share.access_unavailable",
])
const InternalErrorResponseSchema = codedErrorResponseSchema(["internal.unexpected"])

export function registerSharedAccessRoutes(app: Elysia, host: SixbHostView) {
  const guard = new SharedAccessGuard(host)

  return app
    .post(
      "/api/shares/:grantId/exchange",
      async ({ body, params, request }) => {
        try {
          const input = ExchangeSharedAccessBodySchema.parse(body)
          const exchanged = await guard.exchange(params.grantId, input.secret)
          if (!exchanged) {
            return sharedJsonResponse(
              {
                error: "Shared access is unavailable.",
                code: "share.access_unavailable",
              },
              401
            )
          }

          const csrfToken = guard.createCsrfToken()
          return sharedJsonResponse(
            SharedAccessContextSchema.parse(serializeContext(exchanged.context, csrfToken)),
            200,
            guard.createSessionCookies({
              request,
              grantId: params.grantId,
              sessionValue: exchanged.cookieValue,
              csrfToken,
              expiresAt: exchanged.context.session.expiresAt,
            })
          )
        } catch (error) {
          return sharedInternalErrorResponse(error)
        }
      },
      {
        params: SharedAccessGrantParamsSchema,
        body: ExchangeSharedAccessBodySchema,
        response: {
          200: SharedAccessContextSchema,
          401: SharedAccessUnavailableErrorResponseSchema,
          500: InternalErrorResponseSchema,
        },
        detail: {
          summary: "Exchange a shared link for a short-lived session",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "exchangeSharedAccess",
          security: [],
        },
      }
    )
    .get(
      "/api/shares/:grantId/session",
      async ({ params, request }) => {
        try {
          const context = await guard.resolve(request, params.grantId)
          if (!context) {
            return sharedJsonResponse(
              { authenticated: false as const },
              200,
              guard.hasSessionCookie(request)
                ? guard.clearSessionCookies(request, params.grantId)
                : []
            )
          }

          const csrf = guard.resolveCsrf(request, params.grantId, context.session.expiresAt)
          return sharedJsonResponse(
            SharedAccessContextSchema.parse(serializeContext(context, csrf.token)),
            200,
            csrf.setCookie ? [csrf.setCookie] : []
          )
        } catch (error) {
          return sharedInternalErrorResponse(error)
        }
      },
      {
        params: SharedAccessGrantParamsSchema,
        response: {
          200: SharedAccessSessionResponseSchema,
          500: InternalErrorResponseSchema,
        },
        detail: {
          summary: "Get the current shared access session",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "getSharedAccessSession",
          security: [],
        },
      }
    )
    .post(
      "/api/shares/:grantId/sign-out",
      async ({ params, request }) => {
        try {
          const context = await guard.resolve(request, params.grantId)
          if (context && !guard.verifyCsrf(request)) {
            return sharedJsonResponse({ error: "CSRF verification failed" }, 403)
          }
          if (context) await guard.revoke(context)

          return sharedJsonResponse(
            { signedOut: true as const },
            200,
            guard.clearSessionCookies(request, params.grantId)
          )
        } catch (error) {
          return sharedInternalErrorResponse(error)
        }
      },
      {
        params: SharedAccessGrantParamsSchema,
        response: {
          200: SharedAccessSignOutResponseSchema,
          403: ErrorResponseSchema,
          500: InternalErrorResponseSchema,
        },
        detail: {
          summary: "Sign out a shared access session",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "signOutSharedAccess",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}

function sharedInternalErrorResponse(error: unknown): Response {
  const safeError = createUnexpectedRouteError(error)
  return sharedJsonResponse({ error: safeError.message, code: safeError.code }, 500)
}

function serializeContext(context: SharedAccessSessionContext, csrfToken: string) {
  return {
    authenticated: true as const,
    csrfToken,
    grant: {
      id: context.grant.id,
      shareTypeId: context.grant.shareTypeId,
      target: context.grant.target,
      grants: context.grant.grants,
      expiresAt: toIsoString(context.grant.expiresAt),
    },
    session: {
      expiresAt: toIsoString(context.session.expiresAt),
    },
  }
}

function sharedJsonResponse(
  body: unknown,
  status: number,
  setCookies: readonly string[] = []
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  })
  for (const cookie of setCookies) headers.append("set-cookie", cookie)
  return new Response(JSON.stringify(body), { status, headers })
}
