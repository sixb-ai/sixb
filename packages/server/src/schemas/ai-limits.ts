import { z } from "zod"
import { AiMoneySchema } from "./ai-accounting"

const IsoDateSchema = z.string().datetime({ offset: true })

export const AiLimitSubjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project") }),
  z.object({ type: z.literal("group"), id: z.string().trim().min(1) }),
  z.object({ type: z.literal("user"), id: z.string().trim().min(1) }),
  z.object({ type: z.literal("serviceAccount"), id: z.string().trim().min(1) }),
])

export const AiLimitQuantitySchema = z.discriminatedUnion("meter", [
  z.object({
    meter: z.literal("tokens.total"),
    amount: z.number().int().nonnegative().safe(),
  }),
  z.object({
    meter: z.literal("cost.catalogEstimated"),
    amount: AiMoneySchema.extend({ currency: z.literal("USD") }),
  }),
])

export const AiLimitPolicySchema = z.object({
  id: z.string(),
  subject: AiLimitSubjectSchema,
  limit: AiLimitQuantitySchema,
  period: z.literal("calendarMonth"),
  enabled: z.boolean(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
})

export const AiLimitConsumptionSchema = z.object({
  actual: AiLimitQuantitySchema,
  reserved: AiLimitQuantitySchema,
  unknown: AiLimitQuantitySchema,
  remaining: AiLimitQuantitySchema,
})

export const AiLimitPolicyStatusSchema = z.object({
  policy: AiLimitPolicySchema,
  period: z.object({
    kind: z.literal("calendarMonth"),
    start: IsoDateSchema,
    end: IsoDateSchema,
    resetAt: IsoDateSchema,
  }),
  consumption: AiLimitConsumptionSchema,
  accountingStatus: z.enum(["complete", "unavailable"]),
  exhausted: z.boolean(),
  orphaned: z.boolean(),
})

export const AiLimitCapabilitiesSchema = z.object({ manage: z.boolean() })

export const AiLimitSubjectOptionsResponseSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      description: z.string().optional(),
    })
  ),
  users: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      displayName: z.string().optional(),
      status: z.enum(["active", "suspended"]),
    })
  ),
  serviceAccounts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      status: z.enum(["active", "suspended"]),
    })
  ),
})

export const AiLimitListQuerySchema = z.object({
  includeDisabled: z.enum(["true", "false"]).optional(),
})

export const AiLimitStatusQuerySchema = AiLimitListQuerySchema

export const AiLimitPolicyListResponseSchema = z.object({
  items: z.array(AiLimitPolicySchema),
  capabilities: AiLimitCapabilitiesSchema,
})

export const AiLimitPolicyStatusListResponseSchema = z.object({
  items: z.array(AiLimitPolicyStatusSchema),
  capabilities: AiLimitCapabilitiesSchema,
})

export const CreateAiLimitPolicyBodySchema = z.object({
  subject: AiLimitSubjectSchema,
  limit: AiLimitQuantitySchema,
  enabled: z.boolean().optional(),
})

export const UpdateAiLimitPolicyBodySchema = z
  .object({
    limit: AiLimitQuantitySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.limit !== undefined || value.enabled !== undefined, {
    message: "An AI limit update must change limit or enabled.",
  })

export const AiLimitPolicyParamsSchema = z.object({
  limitId: z.string().trim().min(1),
})
