import { z } from "zod"

export const HealthResponseSchema = z.object({ status: z.literal("ok") })

const StorageReadinessSchema = z.object({
  reachable: z.boolean(),
  schemaValid: z.boolean(),
})

export const ReadinessResponseSchema = z.object({
  status: z.enum(["ready", "unready"]),
  storage: StorageReadinessSchema,
  reason: z.string().optional(),
})

const MaintenanceSummarySchema = z.object({
  beatAt: z.string().nullable(),
  stale: z.boolean(),
  passes: z.array(
    z.object({
      id: z.string(),
      lastSucceededAt: z.string().nullable(),
      consecutiveFailures: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
    })
  ),
  outbox: z.object({
    pendingCount: z.number().int().nonnegative(),
    oldestPendingAt: z.string().nullable(),
    retryingCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().nonnegative(),
  }),
})

export const StatusResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "unknown"]),
  objectTypes: z.number().int().nonnegative(),
  maintenance: MaintenanceSummarySchema,
})
