import { z } from "zod"

export const LinkSourceParamsSchema = z.object({
  objectTypeId: z.string().min(1),
  objectId: z.string().min(1),
})

export const LinkParamsSchema = LinkSourceParamsSchema.extend({
  linkId: z.string().min(1),
})

export const RemoveLinkQuerySchema = z.object({
  targetTypeId: z.string().min(1),
  targetId: z.string().min(1),
})

/** A link is named by its target, as for its removal. */
export const LinkLineageQuerySchema = RemoveLinkQuerySchema

export const UpsertLinkBodySchema = z.object({
  targetTypeId: z.string().min(1),
  targetId: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
})
