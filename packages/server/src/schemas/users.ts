import { z } from "zod"
import { UserProfileSchema } from "./auth"

export const MAX_USERS_PAGE_LIMIT = 200
export const MAX_USERS_SEARCH_LENGTH = 200
export const MAX_USER_EMAIL_LENGTH = 320

export const ListUsersQuerySchema = z.object({
  /** Which members to list. Defaults to `active`. */
  status: z.enum(["active", "suspended", "all"]).optional(),
  /** Part of a display name or email, matched ignoring case. */
  search: z.string().max(MAX_USERS_SEARCH_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_USERS_PAGE_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /**
   * The member with exactly this email, ignoring case, suspended or not: a page of at most one.
   * Takes no other option.
   */
  email: z.string().min(1).max(MAX_USER_EMAIL_LENGTH).optional(),
})

export const ListUsersResponseSchema = z.object({
  users: z.array(UserProfileSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const UserParamsSchema = z.object({
  userId: z.string().min(1),
})
