import { AuthorizationError, OntologyValidationError, type SixbHostView } from "@sixb/core"
import {
  bindSharedAccessExecution,
  type SharedAccessSessionContext,
} from "@sixb/core/internal/shares"
import { ObjectNotFoundError } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { RequestActionResponseSchema } from "../schemas/actions"
import { codedErrorResponseSchema, ErrorResponseSchema } from "../schemas/common"
import { TwinObjectSchema } from "../schemas/objects"
import {
  ExchangeSharedAccessBodySchema,
  SharedAccessActionBodySchema,
  SharedAccessActionParamsSchema,
  SharedAccessContextSchema,
  SharedAccessGrantParamsSchema,
  SharedAccessSessionResponseSchema,
  SharedAccessSignOutResponseSchema,
} from "../schemas/shared-access"
import { SharedAccessGuard } from "../shared-access/guard"
import {
  sharedAccessUnavailableResponse,
  sharedActionUnavailableResponse,
  sharedBoundaryErrorResponse,
  sharedInternalErrorResponse,
  sharedInvalidActionResponse,
  sharedJsonResponse,
  sharedResourceNotFoundResponse,
  sharedUnauthenticatedResponse,
} from "../shared-access/responses"
import { toIsoString } from "../utils/http"
import { serializeObject } from "../utils/objects"

const SharedAccessUnavailableErrorResponseSchema = codedErrorResponseSchema([
  "share.access_unavailable",
])
const SharedActionInvalidErrorResponseSchema = codedErrorResponseSchema(["share.action_invalid"])
const SharedActionUnavailableErrorResponseSchema = codedErrorResponseSchema([
  "share.action_unavailable",
])
const SharedResourceNotFoundErrorResponseSchema = codedErrorResponseSchema([
  "share.resource_not_found",
])
const InternalErrorResponseSchema = codedErrorResponseSchema(["internal.unexpected"])

export function registerSharedAccessRoutes(app: Elysia, host: SixbHostView) {
  const guard = new SharedAccessGuard(host)

  return app.group("/api/shares", (shared) =>
    shared
      .onError((context) => sharedBoundaryErrorResponse(context))
      .post(
        "/:grantId/exchange",
        async ({ body, params, request }) => {
          try {
            const input = ExchangeSharedAccessBodySchema.parse(body)
            const exchanged = await guard.exchange(params.grantId, input.secret)
            if (!exchanged) {
              return sharedAccessUnavailableResponse()
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
        "/:grantId/session",
        async ({ params, request }) => {
          try {
            const context = await guard.resolve(request, params.grantId)
            if (!context) {
              return sharedUnauthenticatedResponse(
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
      .get(
        "/:grantId/resource",
        async ({ params, request }) => {
          try {
            const context = await guard.resolve(request, params.grantId)
            if (!context) return unavailableSharedRequest(guard, request, params.grantId)

            const execution = bindSharedAccessExecution(host, { request, context })
            const resource = await execution.getResource()
            if (!resource) return sharedResourceNotFoundResponse()

            return sharedJsonResponse(TwinObjectSchema.parse(serializeObject(resource)), 200)
          } catch (error) {
            return sharedResourceErrorResponse(error)
          }
        },
        {
          params: SharedAccessGrantParamsSchema,
          response: {
            200: TwinObjectSchema,
            401: SharedAccessUnavailableErrorResponseSchema,
            404: SharedResourceNotFoundErrorResponseSchema,
            500: InternalErrorResponseSchema,
          },
          detail: {
            summary: "Get the exact resource authorized by a shared session",
            tags: [OPENAPI_TAGS.sharedAccess.name],
            operationId: "getSharedAccessResource",
            security: [],
          },
        }
      )
      .post(
        "/:grantId/actions/:actionId",
        async ({ body, params, request }) => {
          try {
            const context = await guard.resolve(request, params.grantId)
            if (!context) return unavailableSharedRequest(guard, request, params.grantId)
            if (!guard.verifyCsrf(request)) {
              return sharedJsonResponse({ error: "CSRF verification failed" }, 403)
            }

            const input = SharedAccessActionBodySchema.parse(body)
            const execution = bindSharedAccessExecution(host, { request, context })
            const result = await execution.requestAction(params.actionId, input)
            return sharedJsonResponse(RequestActionResponseSchema.parse(result), 202)
          } catch (error) {
            return sharedActionErrorResponse(error)
          }
        },
        {
          params: SharedAccessActionParamsSchema,
          body: SharedAccessActionBodySchema,
          response: {
            202: RequestActionResponseSchema,
            400: SharedActionInvalidErrorResponseSchema,
            401: SharedAccessUnavailableErrorResponseSchema,
            403: ErrorResponseSchema.or(SharedActionUnavailableErrorResponseSchema),
            404: SharedResourceNotFoundErrorResponseSchema,
            500: InternalErrorResponseSchema,
          },
          detail: {
            summary: "Request an Action on the exact shared resource",
            tags: [OPENAPI_TAGS.sharedAccess.name],
            operationId: "requestSharedAccessAction",
            security: SIXB_CSRF_SECURITY_REQUIREMENT,
          },
        }
      )
      .post(
        "/:grantId/sign-out",
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
  )
}

function unavailableSharedRequest(
  guard: SharedAccessGuard,
  request: Request,
  grantId: string
): Response {
  return sharedAccessUnavailableResponse(
    guard.hasSessionCookie(request) ? guard.clearSessionCookies(request, grantId) : []
  )
}

function sharedResourceErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) return sharedAccessUnavailableResponse()
  if (error instanceof ObjectNotFoundError) return sharedResourceNotFoundResponse()
  return sharedInternalErrorResponse(error)
}

function sharedActionErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) return sharedActionUnavailableResponse()
  if (error instanceof ObjectNotFoundError) return sharedResourceNotFoundResponse()
  if (error instanceof OntologyValidationError) {
    return sharedInvalidActionResponse(error.message)
  }
  return sharedInternalErrorResponse(error)
}

function serializeContext(context: SharedAccessSessionContext, csrfToken: string) {
  return {
    authenticated: true as const,
    csrfToken,
    grant: {
      id: context.grant.id,
      shareTypeId: context.grant.shareTypeId,
      target: context.grant.target,
      grants: context.effectiveGrants,
      expiresAt: toIsoString(context.grant.expiresAt),
    },
    session: {
      expiresAt: toIsoString(context.session.expiresAt),
    },
  }
}
