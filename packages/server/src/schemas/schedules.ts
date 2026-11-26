import { z } from "zod"

export const ScheduleParamsSchema = z.object({
  scheduleId: z.string().min(1),
})

export const RunScheduleResponseSchema = z.object({
  scheduleId: z.string(),
  /** The occurrence's key, under which its `schedule.triggered` event was appended. */
  occurrenceKey: z.string(),
  triggeredAt: z.string(),
})
