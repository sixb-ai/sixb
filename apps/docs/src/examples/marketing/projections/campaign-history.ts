import { col, defineDataset, defineProjection } from "@sixb/core"
import { Campaign } from "../ontology/campaign"

const dailyPerformance = defineDataset("campaigns.daily", {
  schema: [col("campaignId", "string"), col("date", "timestamp"), col("clicks", "int64")],
})

export const campaignHistory = defineProjection("campaign-history", Campaign.p.clicks)
  .fromDataset(dailyPerformance)
  .points({
    objectId: "campaignId",
    at: "date",
    value: "clicks",
  })
