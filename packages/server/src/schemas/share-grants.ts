import { z } from "zod"

const StoredIdentifierSchema = z.string().min(1).refine(isStoredIdentifier, {
  message: "stored identifier must not be blank or contain NUL bytes",
})
const Rfc3339DateSchema = z.string().datetime({ offset: true })
const DestinationPathSchema = z.string().min(1).max(4_096)

const QueryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === true) return true
  if (value === "false" || value === false) return false
  return value
}, z.boolean())

const ShareGrantListLimitSchema = z.preprocess(
  parseUnsignedQueryInteger,
  z.number().int().min(1).max(200)
)

const ShareGrantListOffsetSchema = z.preprocess(
  parseUnsignedQueryInteger,
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
)

function parseUnsignedQueryInteger(value: unknown): unknown {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return value
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : value
}

export const ShareGrantTargetSchema = z.object({
  objectTypeId: StoredIdentifierSchema,
  primaryId: StoredIdentifierSchema,
})

const ShareGrantTargetInputSchema = z.object({
  objectTypeId: StoredIdentifierSchema,
  primaryId: z.string().min(1).refine(isStoredIdentifier, {
    message: "primaryId must not be blank or contain NUL bytes",
  }),
})

const AuthorizablePrincipalSchema = z.object({
  type: z.enum(["user", "serviceAccount"]),
  id: StoredIdentifierSchema,
})

const PrincipalSchema = z.object({
  type: z.enum(["user", "serviceAccount", "system"]),
  id: StoredIdentifierSchema,
})

export const SharedAccessGrantSchema = z.object({
  id: StoredIdentifierSchema,
  definitionId: StoredIdentifierSchema,
  target: ShareGrantTargetSchema,
  issuedBy: AuthorizablePrincipalSchema,
  destinationPath: DestinationPathSchema,
  createdAt: Rfc3339DateSchema,
  expiresAt: Rfc3339DateSchema,
  revokedAt: Rfc3339DateSchema.optional(),
  revokedBy: PrincipalSchema.optional(),
})

export const IssueSharedAccessGrantBodySchema = z.object({
  definitionId: StoredIdentifierSchema,
  target: ShareGrantTargetInputSchema,
  destinationPath: DestinationPathSchema,
  expiresAt: Rfc3339DateSchema,
})

export const IssueSharedAccessGrantResponseSchema = z.object({
  grant: SharedAccessGrantSchema,
  /** Same-origin URL. The bearer secret exists only in its fragment. */
  url: z.string().startsWith("/shared/"),
})

export const ListSharedAccessGrantsQuerySchema = z.object({
  definitionId: StoredIdentifierSchema,
  primaryId: z
    .string()
    .min(1)
    .refine(isStoredIdentifier, {
      message: "primaryId must not be blank or contain NUL bytes",
    })
    .optional(),
  includeRevoked: QueryBooleanSchema.optional(),
  includeExpired: QueryBooleanSchema.optional(),
  limit: ShareGrantListLimitSchema.optional(),
  offset: ShareGrantListOffsetSchema.optional(),
})

export const ListSharedAccessGrantsResponseSchema = z.object({
  grants: z.array(SharedAccessGrantSchema),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative(),
})

export const SharedAccessGrantIdParamsSchema = z.object({
  grantId: StoredIdentifierSchema,
})

export const RevokeSharedAccessGrantResponseSchema = z.object({
  grant: SharedAccessGrantSchema,
})

function isStoredIdentifier(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\0")
}
