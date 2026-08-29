import { z } from "zod"

const StoredIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value && !value.includes("\0"), {
    message: "stored identifier must not be blank or contain NUL bytes",
  })

const Rfc3339DateSchema = z.string().datetime({ offset: true })

export const SharedAccessGrantParamsSchema = z.object({
  grantId: StoredIdentifierSchema,
})

export const ExchangeSharedAccessBodySchema = z.object({
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export const SharedAccessSessionResponseSchema = z.object({
  grantId: StoredIdentifierSchema,
  destinationPath: z.string().min(1).max(4_096),
  expiresAt: Rfc3339DateSchema,
  absoluteExpiresAt: Rfc3339DateSchema,
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export const SharedAccessSignOutResponseSchema = z.object({
  signedOut: z.literal(true),
})
