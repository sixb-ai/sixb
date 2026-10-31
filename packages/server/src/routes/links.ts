import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema, SuccessResponseSchema } from "../schemas/common"
import { LinkLineageSchema } from "../schemas/lineage"
import {
  LinkLineageQuerySchema,
  LinkParamsSchema,
  RemoveLinkQuerySchema,
  UpsertLinkBodySchema,
} from "../schemas/links"
import { handleRouteError } from "../utils/http"

export function registerLinkRoutes(app: Elysia, _host: SixbHostView) {
  return app
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
          security: accessTokenSecurityRequirement("upsertObjectLink"),
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
          security: accessTokenSecurityRequirement("removeObjectLink"),
        },
      }
    )
    .get(
      "/api/objects/:objectTypeId/:objectId/links/:linkId/lineage",
      async (context) => {
        const { params, query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const parsedQuery = LinkLineageQuerySchema.parse(query)
          const objectType = sixb.objects.getTypeById(params.objectTypeId)
          const lineage = objectType
            ? await sixb.objects(objectType).linkLineage({
                sourceId: params.objectId,
                linkId: params.linkId,
                targetTypeId: parsedQuery.targetTypeId,
                targetId: parsedQuery.targetId,
              })
            : null
          if (!lineage) {
            set.status = 404
            return { error: "Link not found" }
          }

          return LinkLineageSchema.parse(lineage)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: LinkParamsSchema,
        query: LinkLineageQuerySchema,
        response: {
          200: LinkLineageSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get where an object link comes from",
          description:
            "What makes the link exist, for the current state. Steps the caller cannot view are left out and counted in `restricted`.",
          tags: [OPENAPI_TAGS.links.name],
          operationId: "getObjectLinkLineage",
          security: accessTokenSecurityRequirement("getObjectLinkLineage"),
        },
      }
    )
}
