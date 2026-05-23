import { z } from "zod"

export const WebhookRunStatusSchema = z.enum(["running", "succeeded", "failed", "skipped"])

export const WebhookDeliveryClaimResultSchema = z.enum(["claimed", "duplicate", "in_progress"])

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
  connectorId: z.string(),
  webhookId: z.string(),
  status: WebhookRunStatusSchema,
  method: z.string(),
  route: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  requestBodyBytes: z.number().optional(),
  responseStatus: z.number().optional(),
  idempotencyKey: z.string().optional(),
  deliveryClaimResult: WebhookDeliveryClaimResultSchema.optional(),
  error: z.string().optional(),
})

export const WebhookRunListResponseSchema = z.object({
  runs: z.array(WebhookRunSchema),
  hasMore: z.boolean(),
  total: z.number(),
})
