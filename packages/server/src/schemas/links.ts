import { z } from "zod"

export const LinkSourceParamsSchema = z.object({
  objectTypeId: z.string().min(1),
  objectId: z.string().min(1),
})

export const LinkParamsSchema = LinkSourceParamsSchema.extend({
  linkId: z.string().min(1),
})

export const LinkQuerySchema = z.object({
  linkId: z.string().optional(),
  direction: z.enum(["outgoing", "incoming", "both"]).default("outgoing"),
})

export const RemoveLinkQuerySchema = z.object({
  targetTypeId: z.string().min(1),
  targetId: z.string().min(1),
})

export const UpsertLinkBodySchema = z.object({
  targetTypeId: z.string().min(1),
  targetId: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
})

export const ObjectLinkSchema = z.object({
  projectId: z.string(),
  sourceTypeId: z.string(),
  sourceId: z.string(),
  linkId: z.string(),
  targetTypeId: z.string(),
  targetId: z.string(),
  properties: z.record(z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
