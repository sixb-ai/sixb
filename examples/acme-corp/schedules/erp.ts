import { defineSchedule } from "@sixb/core"

export const hourlyErpSync = defineSchedule("hourly-erp-sync").cron("0 * * * *", {
  timezone: "Europe/Paris",
})
