import { definePipelineStep } from "@sixb/core"
import { activeCampaigns, rawCampaigns } from "../../datasets/campaigns"

export const selectActive = definePipelineStep("select-active-campaigns")
  .inputs({ campaigns: rawCampaigns })
  .output(activeCampaigns)
  .sql(
    ({ campaigns }) => `
    select id, name, status
    from ${campaigns}
    where status = 'ENABLED'
  `
  )
