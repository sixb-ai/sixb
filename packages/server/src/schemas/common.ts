import { z } from "zod"

export const ErrorResponseSchema = z.object({ error: z.string() })

export const SuccessResponseSchema = z.object({ success: z.boolean() })

export const ActionRequestedResponseSchema = z.object({
  success: z.boolean(),
  runId: z.string(),
  queuedAt: z.string(),
  jobId: z.string().optional(),
  created: z.boolean(),
})
