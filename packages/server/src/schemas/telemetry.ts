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

export const BulkTelemetryHistorySeriesInputSchema = z
  .object({
    objectTypeId: z.string().min(1),
    objectId: z.string().min(1),
    propertyId: z.string().min(1),
  })
  .strict()

export const BulkTelemetryHistoryBodySchema = z
  .object({
    series: z.array(BulkTelemetryHistorySeriesInputSchema).min(1),
    from: z.string().optional(),
    to: z.string().optional(),
    limitPerSeries: z.number().int().nonnegative().optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict()

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

export const BulkTelemetryHistorySeriesSchema = z.object({
  objectTypeId: z.string(),
  objectId: z.string(),
  propertyId: z.string(),
  points: z.array(TelemetryPointSchema),
})

export const BulkTelemetryHistoryResponseSchema = z.object({
  series: z.array(BulkTelemetryHistorySeriesSchema),
})
