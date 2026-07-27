import { defineSchedule } from "@sixb/core"

export const overdueInvoicesSchedule = defineSchedule("daily-overdue-invoices").cron("0 8 * * *")
