import { z } from "zod"

export const AuthInvitationStatusSchema = z.enum(["pending", "accepted", "revoked"])

export const AuthInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  groupIds: z.array(z.string()),
  status: AuthInvitationStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().optional(),
  revokedAt: z.string().optional(),
})

export const AuthInvitationDeliverySchema = z.object({
  status: z.enum(["sent", "skipped", "rate_limited", "not_supported"]),
})

export const CreateAuthInvitationBodySchema = z.object({
  email: z.string().min(1),
  groupIds: z.array(z.string().min(1)).optional(),
  expiresAt: z.string().optional(),
  returnTo: z.string().optional(),
})

export const CreateAuthInvitationResponseSchema = z.object({
  invitation: AuthInvitationSchema,
  delivery: AuthInvitationDeliverySchema,
})

export const ListAuthInvitationsQuerySchema = z.object({
  email: z.string().optional(),
  status: AuthInvitationStatusSchema.optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const ListAuthInvitationsResponseSchema = z.object({
  invitations: z.array(AuthInvitationSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const RevokeAuthInvitationParamsSchema = z.object({
  invitationId: z.string().min(1),
})

export const RevokeAuthInvitationResponseSchema = z.object({
  invitation: AuthInvitationSchema,
})

export const AuthSessionResponseSchema = z.union([
  z.object({
    authenticated: z.literal(false),
  }),
  z.object({
    authenticated: z.literal(true),
    user: z.object({
      id: z.string(),
      email: z.string(),
      displayName: z.string().optional(),
      avatarUrl: z.string().optional(),
      groupIds: z.array(z.string()),
    }),
    session: z.object({
      id: z.string(),
      expiresAt: z.string(),
    }),
  }),
])

export const AuthSignOutResponseSchema = z.object({
  success: z.boolean(),
})
