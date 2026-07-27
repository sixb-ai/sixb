import { z } from "zod"

export const StatusResponseSchema = z.object({
  status: z.literal("ok"),
  objectTypes: z.number(),
})
