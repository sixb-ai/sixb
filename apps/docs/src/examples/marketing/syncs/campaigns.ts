import { defineSync } from "@sixb/core"
import { ads } from "../connectors/google-ads"
import { rawCampaigns } from "../datasets/campaigns"
import { hourly } from "../schedules/campaigns"

export const syncCampaigns = defineSync("google-campaigns")
  .when(hourly)
  .from(ads)
  .read(async function* (client) {
    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID
    if (!customerId) {
      throw new Error("Set GOOGLE_ADS_CUSTOMER_ID")
    }

    const { reports } = client.customer(customerId)
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status
      FROM campaign
    `

    for await (const row of reports.searchAll({ query })) {
      if (row.campaign) yield row.campaign
    }
  })
  .intoDataset(rawCampaigns)
