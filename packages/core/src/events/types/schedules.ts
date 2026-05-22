import type { EventEnvelope } from "../envelope"

export interface ScheduleTriggeredEvent extends EventEnvelope {
  type: "schedule.triggered"
  topic: "schedules"
  partitionKey: string
  payload: {
    scheduleId: string
    occurrenceAt: string
    triggeredAt: string
    occurrenceKey: string
  }
}

export type ScheduleEvent = ScheduleTriggeredEvent
