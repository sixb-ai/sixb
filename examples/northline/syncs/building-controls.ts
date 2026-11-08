import { defineSync } from "@sixb/core"
import { buildingControlsConnector } from "../connectors/building-controls"
import {
  controlsAlarms,
  controlsEquipment,
  controlsRawReadings,
} from "../datasets/building-controls"
import { allRows } from "../lib/sources/client-utils"
import { frequentControlsSync } from "../schedules/source-syncs"

export const syncControlsEquipment = defineSync("sync-controls-equipment")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read((client) => allRows((input) => client.listEquipment(input)))
  .intoDataset(controlsEquipment)

export const syncControlsReadings = defineSync("sync-controls-readings")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read((client) => allRows((input) => client.listReadings(input)))
  .intoDataset(controlsRawReadings)

export const syncControlsAlarms = defineSync("sync-controls-alarms")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read((client) => allRows((input) => client.listAlarms(input)))
  .intoDataset(controlsAlarms)
