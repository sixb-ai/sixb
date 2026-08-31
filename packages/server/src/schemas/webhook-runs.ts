import type { SixbFailure } from "@sixb/core"
import type { WebhookRunFailureCode } from "@sixb/core/storage"
import { WEBHOOK_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { z } from "zod"
import { sixbFailureSchema } from "./common"

const WebhookRunFailureSchema: z.ZodType<SixbFailure<WebhookRunFailureCode>> =
  sixbFailureSchema(WEBHOOK_RUN_FAILURE_CODES)

export const WebhookRunStatusSchema = z.enum(["running", "succeeded", "failed"])

export const WebhookRunsQuerySchema = z.object({
  connectorId: z.string().optional(),
  webhookId: z.string().optional(),
  status: WebhookRunStatusSchema.optional(),
  idempotencyKey: z.string().optional(),
  startedAfter: z.string().optional(),
  startedBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const WebhookRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  executionId: z.string(),
  connectorId: z.string(),
  webhookId: z.string(),
  status: WebhookRunStatusSchema,
  method: z.string(),
  route: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  requestBodyBytes: z.number(),
  responseStatus: z.number().optional(),
  idempotencyKey: z.string().optional(),
  error: WebhookRunFailureSchema.optional(),
})

export const WebhookRunListResponseSchema = z.object({
  runs: z.array(WebhookRunSchema),
  hasMore: z.boolean(),
  total: z.number(),
})
