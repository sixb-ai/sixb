import { type SixbHostView, userRef } from "@sixb/core"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { UserProfileSchema } from "../schemas/auth"
import { ErrorResponseSchema } from "../schemas/common"
import { ListUsersQuerySchema, ListUsersResponseSchema, UserParamsSchema } from "../schemas/users"
import { handleRouteError } from "../utils/http"

export function registerUserRoutes(app: Elysia, _host: SixbHostView) {
  return app
    .get(
      "/api/users",
      async (context) => {
        const { query, set } = context
        const sixb = requireRequestSixb(context)

        try {
          const { email, ...input } = ListUsersQuerySchema.parse(query)
          if (email === undefined) {
            const page = await sixb.users.list(input)
            return { users: [...page.users], hasMore: page.hasMore, total: page.total }
          }

          // `users.get({ email })` over HTTP: a query parameter, so an email never goes in a path.
          if (Object.values(input).some((value) => value !== undefined)) {
            set.status = 400
            return {
              error: "[SixbServer] email finds one member and takes no other option.",
            }
          }
          const profile = await sixb.users.get({ email })
          return { users: profile ? [profile] : [], hasMore: false, total: profile ? 1 : 0 }
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
