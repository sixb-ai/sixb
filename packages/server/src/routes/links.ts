import { isAllowed, type ObjectLinkRow, type OntologySource, type Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
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

function canViewLink(authz: ReturnType<typeof requestAuthState>["authz"], link: ObjectLinkRow) {
  return (
    isAllowed(authz, { kind: "object.view", objectTypeId: link.sourceTypeId }) &&
    isAllowed(authz, { kind: "object.view", objectTypeId: link.targetTypeId })
  )
}

export function registerLinkRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/objects/:objectTypeId/:objectId/links",
      async (context) => {
        const { params, query, set } = context
        const { authz } = requestAuthState(context)
        try {
          const parsedQuery = LinkQuerySchema.parse(query)
          if (!isAllowed(authz, { kind: "object.view", objectTypeId: params.objectTypeId })) {
            set.status = 404
            return { error: "Object not found" }
          }

          const links = await sixb.storage.objects.listLinks({
            projectId: sixb.id,
            objectTypeId: params.objectTypeId,
            objectId: params.objectId,
            linkId: parsedQuery.linkId,
            direction: parsedQuery.direction,
          })

          return links
            .filter((link) => canViewLink(authz, link))
            .map((link) => ({
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
        },
      }
    )
    .put(
      "/api/objects/:objectTypeId/:objectId/links/:linkId",
      async ({ params, body, set }) => {
        try {
          const parsedBody = UpsertLinkBodySchema.parse(body)
          await sixb.upsertLink(params.objectTypeId, params.objectId, params.linkId, {
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
          tags: [OPENAPI_TAGS.links.name],
          operationId: "upsertObjectLink",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .delete(
      "/api/objects/:objectTypeId/:objectId/links/:linkId",
      async ({ params, query, set }) => {
        try {
          const parsedQuery = RemoveLinkQuerySchema.parse(query)
          await sixb.removeLink(params.objectTypeId, params.objectId, params.linkId, {
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
          tags: [OPENAPI_TAGS.links.name],
          operationId: "removeObjectLink",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
