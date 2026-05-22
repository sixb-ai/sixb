import { z } from "zod"

export const ActionParamsSchema = z.object({
  objectTypeId: z.string().min(1),
  objectId: z.string().min(1),
  actionId: z.string().min(1),
})

export const RequestActionBodySchema = z.object({
  params: z.record(z.unknown()).optional(),
})
