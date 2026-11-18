import { defineSync } from "@sixb/core"
import { buildingControlsConnector } from "../../connectors/building-controls"
import { controlsAlarms } from "../../datasets/building-controls/alarms"
import { allRows } from "../../lib/sources/client-utils"
import { frequentControlsSync } from "../../schedules/source-syncs"

export const syncControlsAlarms = defineSync("sync-controls-alarms")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read((client) => allRows((input) => client.listAlarms(input)))
  .intoDataset(controlsAlarms)
