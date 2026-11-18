import { defineSync } from "@sixb/core"
import { buildingControlsConnector } from "../../connectors/building-controls"
import { controlsRawReadings } from "../../datasets/building-controls/raw-readings"
import { allRows } from "../../lib/sources/client-utils"
import { frequentControlsSync } from "../../schedules/source-syncs"

export const syncControlsReadings = defineSync("sync-controls-readings")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read((client) => allRows((input) => client.listReadings(input)))
  .intoDataset(controlsRawReadings)
