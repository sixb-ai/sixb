import { z } from "zod"
import { ActionParamSchema } from "./ontology"

export const ActionIdParamsSchema = z.object({
  actionId: z.string().min(1),
})

export const ActionSubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("none"),
  }),
  z.object({
    kind: z.literal("object"),
    objectTypeId: z.string().min(1),
    primaryId: z.string().min(1),
  }),
])

export const RequestActionBodySchema = z.object({
  subject: ActionSubjectSchema.optional(),
  params: z.record(z.unknown()).optional(),
  runId: z.string().min(1).optional(),
})

export const ActionBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("global"),
  }),
  z.object({
    kind: z.literal("object"),
    objectTypeId: z.string().min(1),
  }),
])

export const ActionCatalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  binding: ActionBindingSchema,
  params: z.array(ActionParamSchema),
})
