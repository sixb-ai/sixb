import type { SixbHostRuntime } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema, SuccessResponseSchema } from "../schemas/common"
import {
  LinkParamsSchema,
  LinkQuerySchema,
  LinkSourceParamsSchema,
  ObjectLinkSchema,
  RemoveLinkQuerySchema,
  UpsertLinkBodySchema,
} from "../schemas/links"
import { handleRouteError, toIsoString } from "../utils/http"

export function registerLinkRoutes(app: Elysia, _host: SixbHostRuntime) {
  return app
    .get(
      "/api/objects/:objectTypeId/:objectId/links",
      async (context) => {
        const { params, query, set } = context
        try {
          const sixb = requireRequestSixb(context)
          if (!sixb.objects.getTypeById(params.objectTypeId)) {
            set.status = 404
            return { error: "Object not found" }
          }
          const parsedQuery = LinkQuerySchema.parse(query)
          const links = await sixb.objects.listLinks({
            objectTypeId: params.objectTypeId,
            objectId: params.objectId,
            linkId: parsedQuery.linkId,
            direction: parsedQuery.direction,
          })

          return links.map((link) => ({
            ...link,
            createdAt: toIsoString(link.createdAt),
            updatedAt: toIsoString(link.updatedAt),
          }))
        } catch (error) {
          set.status = 400
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      {
        params: LinkSourceParamsSchema,
        query: LinkQuerySchema,
        response: {
          200: ObjectLinkSchema.array(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "List object links",
          tags: [OPENAPI_TAGS.links.name],
          operationId: "listObjectLinks",
          security: bearerSecurityRequirement("listObjectLinks"),
        },
      }
    )
    .put(
      "/api/objects/:objectTypeId/:objectId/links/:linkId",
      async (context) => {
        const { params, body, set } = context
        try {
          const parsedBody = UpsertLinkBodySchema.parse(body)
          await requireRequestSixb(context).objects.upsertLink(
            params.objectTypeId,
            params.objectId,
            params.linkId,
            {
              targetTypeId: parsedBody.targetTypeId,
              targetId: parsedBody.targetId,
              properties: parsedBody.properties,
            }
          )

          return { success: true }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: LinkParamsSchema,
        body: UpsertLinkBodySchema,
        response: {
          200: SuccessResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Create or update object link",
          tags: [OPENAPI_TAGS.links.name],
          operationId: "upsertObjectLink",
          security: bearerSecurityRequirement("upsertObjectLink"),
        },
      }
    )
    .delete(
      "/api/objects/:objectTypeId/:objectId/links/:linkId",
      async (context) => {
        const { params, query, set } = context
        try {
          const parsedQuery = RemoveLinkQuerySchema.parse(query)
          await requireRequestSixb(context).objects.removeLink(
            params.objectTypeId,
            params.objectId,
            params.linkId,
            {
              targetTypeId: parsedQuery.targetTypeId,
              targetId: parsedQuery.targetId,
            }
          )

          return { success: true }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: LinkParamsSchema,
        query: RemoveLinkQuerySchema,
        response: {
          200: SuccessResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Remove object link",
          tags: [OPENAPI_TAGS.links.name],
          operationId: "removeObjectLink",
          security: bearerSecurityRequirement("removeObjectLink"),
        },
      }
    )
}
