import { definePipelineStep } from "@sixb/core"
import { activeCampaigns, cleanCampaigns } from "../../datasets/campaigns"

export const cleanNames = definePipelineStep("clean-campaign-names")
  .inputs({ campaigns: activeCampaigns })
  .output(cleanCampaigns)
  .sql(
    ({ campaigns }) => `
    select id, trim(name) as name, status
    from ${campaigns}
  `
  )
