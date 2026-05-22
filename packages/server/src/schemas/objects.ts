import { z } from "zod"

export const ObjectParamsSchema = z.object({
  objectTypeId: z.string().min(1),
  objectId: z.string().min(1),
})

export const ObjectsQuerySchema = z.object({
  objectTypeId: z.string().optional(),
  idPrefix: z.string().optional(),
  idSuffix: z.string().optional(),
  updatedAfter: z.string().optional(),
  updatedBefore: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  orderBy: z.enum(["createdAt", "updatedAt", "primaryId"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const UpsertObjectBodySchema = z.object({
  properties: z.record(z.unknown()),
})

export const TwinObjectSchema = z.object({
  primaryId: z.string(),
  objectTypeId: z.string(),
  properties: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const ObjectListResponseSchema = z.object({
  objects: z.array(TwinObjectSchema),
  hasMore: z.boolean(),
  total: z.number(),
})
