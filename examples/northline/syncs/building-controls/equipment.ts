import { defineSync } from "@sixb/core"
import { buildingControlsConnector } from "../../connectors/building-controls"
import { controlsEquipment } from "../../datasets/building-controls/equipment"
import { allRows } from "../../lib/sources/client-utils"
import { frequentControlsSync } from "../../schedules/source-syncs"

export const syncControlsEquipment = defineSync("sync-controls-equipment")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read((client) => allRows((input) => client.listEquipment(input)))
  .intoDataset(controlsEquipment)
