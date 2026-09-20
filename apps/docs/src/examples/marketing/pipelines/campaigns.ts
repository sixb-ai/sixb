import { definePipeline } from "@sixb/core"
import { campaignsUpdated } from "../schedules/campaigns"
import { cleanNames } from "./steps/clean-names"
import { selectActive } from "./steps/select-active"

export const prepareCampaigns = definePipeline("prepare-campaigns")
  .when(campaignsUpdated)
  .then(selectActive)
  .then(cleanNames)
