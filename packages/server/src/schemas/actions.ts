import { z } from "zod"
import { ActionParamSchema } from "./ontology"

export const ActionIdParamsSchema = z.object({
  actionId: z.string().min(1),
})

export const ObjectActionParamsSchema = z.object({
  objectTypeId: z.string().min(1),
  objectId: z.string().min(1),
  actionId: z.string().min(1),
})

export const RequestActionBodySchema = z.object({
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
