import type { OntologySource, Pario } from "@pario/core"
import type { Elysia } from "elysia"
import { PARIO_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
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

export function registerLinkRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app
    .get(
      "/api/objects/:objectTypeId/:objectId/links",
      async ({ params, query, set }) => {
        try {
          const parsedQuery = LinkQuerySchema.parse(query)
          const links = await pario.storage.objects.listLinks({
            projectId: pario.id,
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
        response: { 200: ObjectLinkSchema.array(), 400: ErrorResponseSchema },
        detail: {
          summary: "List object links",
          tags: ["Links"],
          operationId: "listObjectLinks",
        },
      }
    )
    .put(
      "/api/objects/:objectTypeId/:objectId/links/:linkId",
      async ({ params, body, set }) => {
        try {
          const parsedBody = UpsertLinkBodySchema.parse(body)
          await pario.upsertLink(params.objectTypeId, params.objectId, params.linkId, {
            targetTypeId: parsedBody.targetTypeId,
            targetId: parsedBody.targetId,
            properties: parsedBody.properties,
          })

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
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Create or update object link",
          tags: ["Links"],
          operationId: "upsertObjectLink",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .delete(
      "/api/objects/:objectTypeId/:objectId/links/:linkId",
      async ({ params, query, set }) => {
        try {
          const parsedQuery = RemoveLinkQuerySchema.parse(query)
          await pario.removeLink(params.objectTypeId, params.objectId, params.linkId, {
            targetTypeId: parsedQuery.targetTypeId,
            targetId: parsedQuery.targetId,
          })

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
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Remove object link",
          tags: ["Links"],
          operationId: "removeObjectLink",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
