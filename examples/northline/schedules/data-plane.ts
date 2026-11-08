import { defineSchedule, events } from "@sixb/core"
import {
  controlsAlarms,
  controlsEquipment,
  controlsRawReadings,
} from "../datasets/building-controls"
import { businessContracts, businessFacilities } from "../datasets/business-system"

export const rawReadingsUpdated = defineSchedule("controls-raw-readings-updated").on(
  events.dataset(controlsRawReadings).updated()
)

// Service cases join alarms to equipment, facilities and contracts, so each of them re-derives the
// cases. The sources sync on different clocks: on a fresh start alarms land within minutes and
// contracts on the hour, and the run that follows the last of them is the one that succeeds.
export const alarmsUpdated = defineSchedule("controls-alarms-updated").on(
  events.dataset(controlsAlarms).updated()
)

export const equipmentUpdated = defineSchedule("controls-equipment-updated").on(
  events.dataset(controlsEquipment).updated()
)

export const facilitiesUpdated = defineSchedule("business-facilities-updated").on(
  events.dataset(businessFacilities).updated()
)

export const contractsUpdated = defineSchedule("business-contracts-updated").on(
  events.dataset(businessContracts).updated()
)
