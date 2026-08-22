import { z } from "zod"
import { ShareGrantRefSchema, ShareGrantTargetSchema } from "./share-grants"

export const SharedAccessGrantParamsSchema = z.object({
  grantId: z.string().min(1),
})

export const ExchangeSharedAccessBodySchema = z.object({
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export const SharedAccessContextSchema = z.object({
  authenticated: z.literal(true),
  csrfToken: z.string().min(1),
  grant: z.object({
    id: z.string().min(1),
    shareTypeId: z.string().min(1),
    target: ShareGrantTargetSchema,
    grants: z.array(ShareGrantRefSchema),
    expiresAt: z.string().datetime(),
  }),
  session: z.object({
    expiresAt: z.string().datetime(),
  }),
})

export const SharedAccessSessionResponseSchema = z.discriminatedUnion("authenticated", [
  SharedAccessContextSchema,
  z.object({ authenticated: z.literal(false) }),
])

export const SharedAccessSignOutResponseSchema = z.object({
  signedOut: z.literal(true),
})
