import { col, defineDataset } from "@sixb/core"

export const rawCampaigns = defineDataset("google.campaigns", {
  schema: [col("id", "string"), col("name", "string"), col("status", "string")],
  primaryKey: "id",
})

export const activeCampaigns = defineDataset("campaigns.active").derive(rawCampaigns, {
  primaryKey: "id",
})

export const cleanCampaigns = defineDataset("campaigns.clean").derive(rawCampaigns, {
  primaryKey: "id",
})
