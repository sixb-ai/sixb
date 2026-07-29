import { defineSync } from "@sixb/core"
import { buildingControlsConnector } from "../connectors/building-controls"
import {
  controlsAlarms,
  controlsEquipment,
  controlsRawReadings,
} from "../datasets/building-controls"
import { frequentControlsSync } from "../schedules/source-syncs"

export const syncControlsEquipment = defineSync("sync-controls-equipment")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read(async (client) => (await client.listEquipment()).rows)
  .intoDataset(controlsEquipment)

export const syncControlsReadings = defineSync("sync-controls-readings")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read(async (client) => (await client.listReadings()).rows)
  .intoDataset(controlsRawReadings)

export const syncControlsAlarms = defineSync("sync-controls-alarms")
  .when(frequentControlsSync)
  .from(buildingControlsConnector)
  .read(async (client) => (await client.listAlarms()).rows)
  .intoDataset(controlsAlarms)
