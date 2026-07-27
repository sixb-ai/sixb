import type { ObjectProjectionDefinition } from "@sixb/core"
import { defineProjection, defineTelemetryProjection } from "@sixb/core"
import { panasonicDeviceSnapshots } from "../datasets/deviceSnapshots"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const panasonicDevicesProjection: ObjectProjectionDefinition = defineProjection(
  "panasonic-devices",
  PanasonicAcUnit
)
  .fromDataset(panasonicDeviceSnapshots)
  .properties({ id: "id", guid: "guid", deviceName: "deviceName" })

export const panasonicPowerProjection = defineTelemetryProjection(
  "panasonic-power",
  PanasonicAcUnit.p.power
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "power" })

export const panasonicOperatingModeProjection = defineTelemetryProjection(
  "panasonic-operating-mode",
  PanasonicAcUnit.p.operatingMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "operatingMode" })

export const panasonicIndoorTemperatureProjection = defineTelemetryProjection(
  "panasonic-indoor-temperature",
  PanasonicAcUnit.p.indoorTemperature
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({
    objectId: "id",
    at: "observedAt",
    value: "indoorTemperature",
    unit: "temperatureUnit",
  })

export const panasonicOutdoorTemperatureProjection = defineTelemetryProjection(
  "panasonic-outdoor-temperature",
  PanasonicAcUnit.p.outdoorTemperature
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({
    objectId: "id",
    at: "observedAt",
    value: "outdoorTemperature",
    unit: "temperatureUnit",
  })

export const panasonicTargetTemperatureProjection = defineTelemetryProjection(
  "panasonic-target-temperature",
  PanasonicAcUnit.p.targetTemperature
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({
    objectId: "id",
    at: "observedAt",
    value: "targetTemperature",
    unit: "temperatureUnit",
  })

export const panasonicFanSpeedProjection = defineTelemetryProjection(
  "panasonic-fan-speed",
  PanasonicAcUnit.p.fanSpeed
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "fanSpeed" })

export const panasonicSwingHorizontalProjection = defineTelemetryProjection(
  "panasonic-swing-horizontal",
  PanasonicAcUnit.p.swingHorizontal
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "swingHorizontal" })

export const panasonicSwingVerticalProjection = defineTelemetryProjection(
  "panasonic-swing-vertical",
  PanasonicAcUnit.p.swingVertical
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "swingVertical" })

export const panasonicEcoModeProjection = defineTelemetryProjection(
  "panasonic-eco-mode",
  PanasonicAcUnit.p.ecoMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "ecoMode" })

export const panasonicNanoeModeProjection = defineTelemetryProjection(
  "panasonic-nanoe-mode",
  PanasonicAcUnit.p.nanoeMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "nanoeMode" })

export const panasonicEcoNaviModeProjection = defineTelemetryProjection(
  "panasonic-eco-navi-mode",
  PanasonicAcUnit.p.ecoNaviMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "ecoNaviMode" })

export const panasonicIAutoModeProjection = defineTelemetryProjection(
  "panasonic-i-auto-mode",
  PanasonicAcUnit.p.iAutoMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "iAutoMode" })
