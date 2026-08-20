import { z } from "zod"

export const ShareGrantTargetSchema = z.object({
  objectTypeId: z.string().min(1),
  primaryId: z.string().min(1),
})

export const ShareGrantPrincipalSchema = z.object({
  type: z.enum(["user", "serviceAccount"]),
  id: z.string().min(1),
})

export const ShareGrantRevocationPrincipalSchema = z.object({
  type: z.enum(["user", "serviceAccount", "system"]),
  id: z.string().min(1),
})

export const ShareGrantRefSchema = z.union([
  z.object({ capability: z.literal("view"), objectTypeId: z.string().min(1) }),
  z.object({ capability: z.literal("apply"), actionId: z.string().min(1) }),
])

export const SharedAccessGrantSchema = z.object({
  id: z.string().min(1),
  shareTypeId: z.string().min(1),
  target: ShareGrantTargetSchema,
  issuedBy: ShareGrantPrincipalSchema,
  grants: z.array(ShareGrantRefSchema),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
  revokedBy: ShareGrantRevocationPrincipalSchema.optional(),
})

export const IssueSharedAccessGrantBodySchema = z.object({
  shareTypeId: z.string().min(1),
  target: ShareGrantTargetSchema,
  expiresAt: z.string().datetime(),
})

export const IssueSharedAccessGrantResponseSchema = z.object({
  grant: SharedAccessGrantSchema,
  url: z.string().url(),
})

export const ListSharedAccessGrantsQuerySchema = z.object({
  shareTypeId: z.string().min(1),
  objectTypeId: z.string().min(1),
  primaryId: z.string().min(1),
  includeRevoked: z.enum(["true", "false"]).optional(),
  includeExpired: z.enum(["true", "false"]).optional(),
})

export const ListSharedAccessGrantsResponseSchema = z.object({
  grants: z.array(SharedAccessGrantSchema),
})

export const SharedAccessGrantIdParamsSchema = z.object({
  grantId: z.string().min(1),
})
