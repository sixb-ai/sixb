import { defineSchedule, events } from "@sixb/core"
import { rawCampaigns } from "../datasets/campaigns"

export const hourly = defineSchedule("hourly-campaigns").cron("0 * * * *")

export const campaignsUpdated = defineSchedule("campaigns-updated").on(
  events.dataset(rawCampaigns).updated()
)
