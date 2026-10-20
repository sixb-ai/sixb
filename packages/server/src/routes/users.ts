import { type SixbHostView, userRef } from "@sixb/core"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ListUsersQuerySchema,
  ListUsersResponseSchema,
  UserParamsSchema,
  UserProfileSchema,
} from "../schemas/users"
import { handleRouteError } from "../utils/http"

export function registerUserRoutes(app: Elysia, _host: SixbHostView) {
  return app
    .get(
      "/api/users",
      async (context) => {
        const { query, set } = context
        const sixb = requireRequestSixb(context)

        try {
          const page = await sixb.users.list(ListUsersQuerySchema.parse(query))
          return { users: [...page.users], hasMore: page.hasMore, total: page.total }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: ListUsersQuerySchema,
        response: {
          200: ListUsersResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
        detail: {
          summary: "List project members",
          tags: [OPENAPI_TAGS.users.name],
          operationId: "listUsers",
          security: accessTokenSecurityRequirement("listUsers"),
        },
      }
    )
    .get(
      "/api/users/:userId",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)

        try {
          const profile = await sixb.users.get(userRef(params.userId))
          if (profile) return profile

          set.status = 404
          return { error: `[SixbServer] User '${params.userId}' not found.` }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: UserParamsSchema,
        response: {
          200: UserProfileSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get a project member",
          tags: [OPENAPI_TAGS.users.name],
          operationId: "getUser",
          security: accessTokenSecurityRequirement("getUser"),
        },
      }
    )
}
