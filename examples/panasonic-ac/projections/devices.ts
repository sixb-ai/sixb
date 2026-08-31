import type { ObjectProjectionDefinition } from "@sixb/core"
import { defineProjection } from "@sixb/core"
import { panasonicDeviceSnapshots } from "../datasets/deviceSnapshots"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const panasonicDevicesProjection: ObjectProjectionDefinition = defineProjection(
  "panasonic-devices",
  PanasonicAcUnit
)
  .fromDataset(panasonicDeviceSnapshots)
  .properties({ id: "id", guid: "guid", deviceName: "deviceName" })

export const panasonicTelemetryProjection = defineProjection("panasonic-telemetry", PanasonicAcUnit)
  .fromDataset(panasonicDeviceSnapshots)
  .points({
    objectId: "id",
    at: "observedAt",
    properties: {
      power: "power",
      operatingMode: "operatingMode",
      indoorTemperature: { value: "indoorTemperature", unit: "temperatureUnit" },
      outdoorTemperature: { value: "outdoorTemperature", unit: "temperatureUnit" },
      targetTemperature: { value: "targetTemperature", unit: "temperatureUnit" },
      fanSpeed: "fanSpeed",
      swingHorizontal: "swingHorizontal",
      swingVertical: "swingVertical",
      ecoMode: "ecoMode",
      nanoeMode: "nanoeMode",
      ecoNaviMode: "ecoNaviMode",
      iAutoMode: "iAutoMode",
    },
  })
