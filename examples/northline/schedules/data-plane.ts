import { defineSchedule, events } from "@sixb/core"
import { controlsAlarms, controlsRawReadings } from "../datasets/building-controls"

export const rawReadingsUpdated = defineSchedule("controls-raw-readings-updated").on(
  events.dataset(controlsRawReadings).updated()
)

export const alarmsUpdated = defineSchedule("controls-alarms-updated").on(
  events.dataset(controlsAlarms).updated()
)
