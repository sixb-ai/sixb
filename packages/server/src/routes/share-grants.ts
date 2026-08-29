import {
  AuthorizationError,
  type SharedAccessGrant,
  ShareError,
  type SixbHostView,
} from "@sixb/core"
import { ObjectNotFoundError } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  IssueSharedAccessGrantBodySchema,
  IssueSharedAccessGrantResponseSchema,
  ListSharedAccessGrantsQuerySchema,
  ListSharedAccessGrantsResponseSchema,
  RevokeSharedAccessGrantResponseSchema,
  SharedAccessGrantIdParamsSchema,
  SharedAccessGrantSchema,
} from "../schemas/share-grants"

const INTERNAL_ERROR = "[SixbServer] Shared-access operation failed."
const STORAGE_UNAVAILABLE_ERROR =
  "[SixbServer] Shared-access grant storage is not configured on this runtime."

export function registerShareGrantRoutes(app: Elysia, _host: SixbHostView) {
  return app
    .post(
      "/api/share-grants",
      async (context) => {
        const { body, set } = context
        setNoStore(set)
        try {
          const invitation = await requireRequestSixb(context).shares.issueById({
            definitionId: body.definitionId,
            target: body.target,
            destinationPath: body.destinationPath,
            expiresAt: new Date(body.expiresAt),
          })
          const grant = serializeSharedAccessGrant(invitation.grant)

          set.status = 201
          return IssueSharedAccessGrantResponseSchema.parse({
            grant,
            url: sharedAccessUrl(grant.id, grant.destinationPath, invitation.secret),
          })
        } catch (error) {
          return handleShareGrantRouteError(error, set)
        }
      },
      {
        body: IssueSharedAccessGrantBodySchema,
        response: {
          201: IssueSharedAccessGrantResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        error: sharedAccessValidationError("Invalid shared-access grant request."),
        detail: {
          summary: "Issue a shared-access grant",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "issueSharedAccessGrant",
          security: bearerSecurityRequirement("issueSharedAccessGrant"),
        },
      }
    )
    .get(
      "/api/share-grants",
      async (context) => {
        const { query, set } = context
        setNoStore(set)
        try {
          const result = await requireRequestSixb(context).shares.listById({
            definitionId: query.definitionId,
            primaryId: query.primaryId,
            includeRevoked: query.includeRevoked,
            includeExpired: query.includeExpired,
            limit: query.limit,
            offset: query.offset,
          })

          return ListSharedAccessGrantsResponseSchema.parse({
            grants: result.grants.map(serializeSharedAccessGrant),
            total: result.total,
            hasMore: result.hasMore,
          })
        } catch (error) {
          return handleShareGrantRouteError(error, set)
        }
      },
      {
        query: ListSharedAccessGrantsQuerySchema,
        response: {
          200: ListSharedAccessGrantsResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        error: sharedAccessValidationError("Invalid shared-access grant query."),
        detail: {
          summary: "List shared-access grants",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "listSharedAccessGrants",
          security: bearerSecurityRequirement("listSharedAccessGrants"),
        },
      }
    )
    .delete(
      "/api/share-grants/:grantId",
      async (context) => {
        const { params, set } = context
        setNoStore(set)
        try {
          const grant = await requireRequestSixb(context).shares.revoke(params.grantId)
          if (!grant) {
            set.status = 404
            return { error: "[SixbServer] Shared-access grant not found." }
          }

          return RevokeSharedAccessGrantResponseSchema.parse({
            grant: serializeSharedAccessGrant(grant),
          })
        } catch (error) {
          return handleShareGrantRouteError(error, set)
        }
      },
      {
        params: SharedAccessGrantIdParamsSchema,
        response: {
          200: RevokeSharedAccessGrantResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        error: sharedAccessValidationError("Invalid shared-access grant id."),
        detail: {
          summary: "Revoke a shared-access grant",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "revokeSharedAccessGrant",
          security: bearerSecurityRequirement("revokeSharedAccessGrant"),
        },
      }
    )
}

function serializeSharedAccessGrant(grant: SharedAccessGrant) {
  return SharedAccessGrantSchema.parse({
    id: grant.id,
    definitionId: grant.definitionId,
    target: grant.target,
    issuedBy: grant.issuedBy,
    destinationPath: grant.destinationPath,
    createdAt: grant.createdAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt.toISOString() }),
    ...(grant.revokedBy === undefined ? {} : { revokedBy: grant.revokedBy }),
  })
}

function sharedAccessUrl(grantId: string, destinationPath: string, secret: string): string {
  return `/shared/${encodeURIComponent(grantId)}${destinationPath}#${encodeURIComponent(secret)}`
}

function handleShareGrantRouteError(
  error: unknown,
  set: { status?: number | string }
): { error: string } {
  if (error instanceof ShareError) {
    set.status = shareErrorStatus(error)
    if (error.reason === "storage_failure") return { error: INTERNAL_ERROR }
    if (error.reason === "storage_unavailable") return { error: STORAGE_UNAVAILABLE_ERROR }
    if (error.reason === "unauthenticated") return { error: "Authentication required." }
    return { error: error.message }
  }
  if (error instanceof AuthorizationError) {
    set.status = 403
    return { error: error.message }
  }
  if (error instanceof ObjectNotFoundError) {
    set.status = 404
    return { error: error.message }
  }

  set.status = 500
  return { error: INTERNAL_ERROR }
}

function shareErrorStatus(error: ShareError): number {
  switch (error.reason) {
    case "invalid_input":
      return 400
    case "not_found":
      return 404
    case "unauthenticated":
      return 401
    case "storage_unavailable":
      return 501
    case "storage_failure":
      return 500
  }
}

function sharedAccessValidationError(message: string) {
  return ({
    code,
    set,
  }: {
    code: unknown
    set: { status?: number | string; headers?: unknown }
  }) => {
    if (code !== "VALIDATION") return
    setNoStore(set)
    set.status = 400
    return { error: message }
  }
}

function setNoStore(set: { headers?: unknown }): void {
  if (set.headers instanceof Headers) {
    set.headers.set("cache-control", "no-store")
    return
  }
  if (!set.headers || typeof set.headers !== "object" || Array.isArray(set.headers)) {
    set.headers = {}
  }
  ;(set.headers as Record<string, string>)["cache-control"] = "no-store"
}
