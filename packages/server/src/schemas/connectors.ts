import { z } from "zod"

export const ConnectorParamsSchema = z.object({
  connectorId: z.string().min(1),
})

export const ConnectorWebhookSchema = z.object({
  id: z.string(),
  method: z.literal("POST"),
  route: z.string(),
  bodyFormat: z.enum(["json", "text", "raw"]),
  hasVerify: z.boolean(),
  hasIdempotency: z.boolean(),
})

export const ConnectorSchema = z.object({
  id: z.string(),
  type: z.string(),
  syncIds: z.array(z.string()),
  webhooks: z.array(ConnectorWebhookSchema),
})
