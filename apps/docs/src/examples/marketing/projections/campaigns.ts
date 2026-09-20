import { defineProjection } from "@sixb/core"
import { cleanCampaigns } from "../datasets/campaigns"
import { Campaign } from "../ontology/campaign"

export const projectCampaigns = defineProjection("campaigns", Campaign)
  .fromDataset(cleanCampaigns)
  .properties({
    id: "id",
    name: "name",
    status: "status",
  })
