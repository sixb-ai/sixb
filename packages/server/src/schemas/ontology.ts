import { z } from "zod"

export const ObjectTypeParamsSchema = z.object({ objectTypeId: z.string().min(1) })

export const PropertyDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mode: z.enum(["static", "telemetry"]).optional(),
  required: z.boolean().optional(),
  nullable: z.boolean().optional(),
  primary: z.boolean().optional(),
  semanticType: z.string().optional(),
  schema: z.unknown(),
  query: z
    .object({
      searchable: z.boolean().optional(),
      filterable: z.boolean().optional(),
      sortable: z.boolean().optional(),
      text: z.boolean().optional(),
      exact: z.boolean().optional(),
      facet: z.boolean().optional(),
      vector: z.boolean().optional(),
      weight: z.number().optional(),
    })
    .optional(),
})

export const LinkDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  targetObjectTypeId: z.union([z.string(), z.array(z.string())]),
  cardinality: z.enum(["one", "many"]).optional(),
  properties: z.array(PropertyDefinitionSchema).optional(),
})

export const ActionParamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  semanticType: z.string().optional(),
  schema: z.unknown(),
})

export const ActionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  params: z.array(ActionParamSchema),
})

export const ObjectTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  extends: z.string().optional(),
  implements: z.array(z.string()).optional(),
  properties: z.array(PropertyDefinitionSchema),
  search: z
    .object({
      title: z.string().optional(),
      defaultText: z.array(z.string()).optional(),
      exact: z.array(z.string()).optional(),
      vector: z
        .object({
          property: z.string(),
          source: z.array(z.string()),
        })
        .optional(),
    })
    .optional(),
  links: z.array(LinkDefinitionSchema),
  actions: z.array(ActionSchema),
})
