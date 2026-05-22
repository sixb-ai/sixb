import { z } from "zod"

export const TelemetryParamsSchema = z.object({
  objectTypeId: z.string().min(1),
  objectId: z.string().min(1),
  propertyId: z.string().min(1),
})

export const TelemetryHistoryQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const AppendTelemetryBodySchema = z.object({
  value: z.unknown(),
  unit: z.string().optional(),
  at: z.string().optional(),
})

export const TelemetryPointSchema = z.object({
  projectId: z.string(),
  objectTypeId: z.string(),
  objectId: z.string(),
  propertyId: z.string(),
  value: z.unknown(),
  unit: z.string().optional(),
  at: z.string(),
})
