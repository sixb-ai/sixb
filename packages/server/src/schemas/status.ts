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
  running: z.boolean(),
  intervalMs: z.number().int().positive(),
  lastStartedAt: z.string().nullable(),
  lastCompletedAt: z.string().nullable(),
  lastDurationMs: z.number().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  outbox: z
    .object({
      pendingCount: z.number().int().nonnegative(),
      oldestPendingAt: z.string().nullable(),
      retryingCount: z.number().int().nonnegative(),
      maxAttempts: z.number().int().nonnegative(),
    })
    .nullable(),
  terminalSources: z
    .object({
      count: z.number().int().nonnegative(),
      oldestTerminalAt: z.string().nullable(),
    })
    .nullable(),
  cleanup: z
    .object({
      publishedOutboxRowsDeleted: z.number().int().nonnegative(),
      terminalSourceRowsDeleted: z.number().int().nonnegative(),
      terminalSourceMaterializationsDeleted: z.number().int().nonnegative(),
    })
    .nullable(),
})

export const StatusResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  objectTypes: z.number().int().nonnegative(),
  maintenance: MaintenanceSummarySchema,
})
