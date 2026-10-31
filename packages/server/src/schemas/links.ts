import { z } from "zod"

export const LinkParamsSchema = z.object({
  objectTypeId: z.string().min(1),
  objectId: z.string().min(1),
  linkId: z.string().min(1),
})

/** A link is named by its target. */
export const LinkLineageQuerySchema = z.object({
  targetTypeId: z.string().min(1),
  targetId: z.string().min(1),
})
