import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { LinkLineageSchema } from "../schemas/lineage"
import { LinkLineageQuerySchema, LinkParamsSchema } from "../schemas/links"
import { handleRouteError } from "../utils/http"

export function registerLinkRoutes(app: Elysia, _host: SixbHostView) {
  return app.get(
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
