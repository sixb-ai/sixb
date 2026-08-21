import {
  AuthorizationError,
  type SharedAccessGrant,
  ShareError,
  type SixbHostView,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { ObjectNotFoundError } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { codedErrorResponseSchema, ErrorResponseSchema } from "../schemas/common"
import {
  IssueSharedAccessGrantBodySchema,
  IssueSharedAccessGrantResponseSchema,
  ListSharedAccessGrantsQuerySchema,
  ListSharedAccessGrantsResponseSchema,
  SharedAccessGrantIdParamsSchema,
  SharedAccessGrantSchema,
} from "../schemas/share-grants"
import {
  createUnexpectedRouteError,
  handleRouteError,
  toIsoString,
  unconfiguredStorageResponse,
} from "../utils/http"

const ShareTypeNotFoundErrorResponseSchema = codedErrorResponseSchema(["share.type_not_found"])
const ShareGrantNotFoundErrorResponseSchema = codedErrorResponseSchema([
  "share.grant_not_found",
  "share.type_not_found",
])
const InternalErrorResponseSchema = codedErrorResponseSchema(["internal.unexpected"])
const ShareTypeOrTargetNotFoundErrorResponseSchema = z.union([
  ShareTypeNotFoundErrorResponseSchema,
  ErrorResponseSchema,
])
const ShareGrantOrTargetNotFoundErrorResponseSchema = z.union([
  ShareGrantNotFoundErrorResponseSchema,
  ErrorResponseSchema,
])

export interface ShareGrantRouteOptions {
  readonly sharedApplicationOrigin: string | null
}

export function registerShareGrantRoutes(
  app: Elysia,
  host: SixbHostView,
  options: ShareGrantRouteOptions
) {
  return app
    .post(
      "/api/share-grants",
      async (context) => {
        const { body, set } = context
        setNoStore(set)
        if (!host.storage.shareGrants) {
          return unconfiguredStorageResponse(set, "Share grant storage")
        }
        if (!options.sharedApplicationOrigin) {
          set.status = 503
          return { error: "[SixbServer] Shared application origin is not configured." }
        }

        try {
          const sixb = requireRequestSixb(context)
          const input = IssueSharedAccessGrantBodySchema.parse(body)
          const invitation = await sixb.shares.issue({
            type: input.shareTypeId,
            target: input.target,
            expiresAt: new Date(input.expiresAt),
          })
          set.status = 201
          return IssueSharedAccessGrantResponseSchema.parse({
            grant: serializeGrant(invitation.grant),
            url: createSharedUrl(
              options.sharedApplicationOrigin,
              invitation.grant.shareTypeId,
              invitation.grant.id,
              invitation.secret
            ),
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
          404: ShareTypeOrTargetNotFoundErrorResponseSchema,
          500: InternalErrorResponseSchema,
          501: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
        detail: {
          summary: "Issue a shared access grant",
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
        if (!host.storage.shareGrants) {
          return unconfiguredStorageResponse(set, "Share grant storage")
        }
        try {
          const sixb = requireRequestSixb(context)
          const input = ListSharedAccessGrantsQuerySchema.parse(query)
          const grants = await sixb.shares.list({
            type: input.shareTypeId,
            target: { objectTypeId: input.objectTypeId, primaryId: input.primaryId },
            includeRevoked: input.includeRevoked === "true",
            includeExpired: input.includeExpired === "true",
          })
          return ListSharedAccessGrantsResponseSchema.parse({ grants: grants.map(serializeGrant) })
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
          404: ShareTypeOrTargetNotFoundErrorResponseSchema,
          500: InternalErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List shared access grants for one object",
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
        if (!host.storage.shareGrants) {
          return unconfiguredStorageResponse(set, "Share grant storage")
        }
        try {
          const sixb = requireRequestSixb(context)
          const grant = await sixb.shares.revoke(params.grantId)
          if (!grant) {
            return handleRouteError(
              createSixbError("share.grant_not_found", "Shared access grant not found.", {
                details: { grantId: params.grantId },
              }),
              set
            )
          }
          return SharedAccessGrantSchema.parse(serializeGrant(grant))
        } catch (error) {
          return handleShareGrantRouteError(error, set)
        }
      },
      {
        params: SharedAccessGrantIdParamsSchema,
        response: {
          200: SharedAccessGrantSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ShareGrantOrTargetNotFoundErrorResponseSchema,
          500: InternalErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Revoke a shared access grant",
          tags: [OPENAPI_TAGS.sharedAccess.name],
          operationId: "revokeSharedAccessGrant",
          security: bearerSecurityRequirement("revokeSharedAccessGrant"),
        },
      }
    )
}

function handleShareGrantRouteError(error: unknown, set: { status?: number | string }) {
  if (error instanceof ShareError) {
    switch (error.reason) {
      case "not_found":
        return handleRouteError(
          createSixbError("share.type_not_found", "Share type not found.", { cause: error }),
          set
        )
      case "invalid_input":
        set.status = 400
        return { error: error.message }
      case "unauthenticated":
        set.status = 401
        return { error: error.message }
      case "storage_unavailable":
        set.status = 501
        return { error: error.message }
      case "invalid_definition":
        return handleRouteError(createUnexpectedRouteError(error), set)
    }
  }

  if (error instanceof AuthorizationError || error instanceof ObjectNotFoundError) {
    return handleRouteError(error, set)
  }

  return handleRouteError(createUnexpectedRouteError(error), set)
}

function serializeGrant(grant: SharedAccessGrant) {
  return {
    ...grant,
    createdAt: toIsoString(grant.createdAt),
    expiresAt: toIsoString(grant.expiresAt),
    revokedAt: grant.revokedAt ? toIsoString(grant.revokedAt) : undefined,
  }
}

function createSharedUrl(
  origin: string,
  shareTypeId: string,
  grantId: string,
  secret: string
): string {
  const url = new URL(origin)
  url.pathname = `/shared/${encodeURIComponent(shareTypeId)}/${encodeURIComponent(grantId)}`
  url.search = ""
  url.hash = secret
  return url.toString()
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
