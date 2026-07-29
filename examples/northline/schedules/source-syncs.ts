import { defineSchedule } from "@sixb/core"

export const hourlyBusinessSync = defineSchedule("business-system-hourly").cron("0 * * * *", {
  timezone: "America/New_York",
})

export const frequentFieldSync = defineSchedule("field-service-frequent").cron("*/5 * * * *", {
  timezone: "America/New_York",
})

export const frequentControlsSync = defineSchedule("building-controls-frequent").cron(
  "*/2 * * * *",
  { timezone: "America/New_York" }
)
