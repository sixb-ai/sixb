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

export const panasonicPowerProjection = defineProjection("panasonic-power", PanasonicAcUnit.p.power)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "power" })

export const panasonicOperatingModeProjection = defineProjection(
  "panasonic-operating-mode",
  PanasonicAcUnit.p.operatingMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "operatingMode" })

export const panasonicIndoorTemperatureProjection = defineProjection(
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

export const panasonicOutdoorTemperatureProjection = defineProjection(
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

export const panasonicTargetTemperatureProjection = defineProjection(
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

export const panasonicFanSpeedProjection = defineProjection(
  "panasonic-fan-speed",
  PanasonicAcUnit.p.fanSpeed
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "fanSpeed" })

export const panasonicSwingHorizontalProjection = defineProjection(
  "panasonic-swing-horizontal",
  PanasonicAcUnit.p.swingHorizontal
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "swingHorizontal" })

export const panasonicSwingVerticalProjection = defineProjection(
  "panasonic-swing-vertical",
  PanasonicAcUnit.p.swingVertical
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "swingVertical" })

export const panasonicEcoModeProjection = defineProjection(
  "panasonic-eco-mode",
  PanasonicAcUnit.p.ecoMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "ecoMode" })

export const panasonicNanoeModeProjection = defineProjection(
  "panasonic-nanoe-mode",
  PanasonicAcUnit.p.nanoeMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "nanoeMode" })

export const panasonicEcoNaviModeProjection = defineProjection(
  "panasonic-eco-navi-mode",
  PanasonicAcUnit.p.ecoNaviMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "ecoNaviMode" })

export const panasonicIAutoModeProjection = defineProjection(
  "panasonic-i-auto-mode",
  PanasonicAcUnit.p.iAutoMode
)
  .fromDataset(panasonicDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "iAutoMode" })
