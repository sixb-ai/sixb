import { defineObjectType, prop } from "@sixb/core"

export function acUnitKeyFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return `ac-${normalized || "device"}`
}

export const PanasonicAcUnit = defineObjectType({
  id: "panasonic:AcUnit",
  name: "Panasonic AC Unit",
  description: "A Panasonic Comfort Cloud air conditioning unit.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("guid", "string", { required: true }),
    prop("deviceName", "string", { required: true }),
    prop("power", "boolean", { mode: "telemetry" }),
    prop("operatingMode", "integer", { mode: "telemetry" }),
    prop("indoorTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("outdoorTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("targetTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("fanSpeed", "integer", { mode: "telemetry" }),
    prop("swingHorizontal", "integer", { mode: "telemetry" }),
    prop("swingVertical", "integer", { mode: "telemetry" }),
    prop("ecoMode", "boolean", { mode: "telemetry" }),
    prop("nanoeMode", "boolean", { mode: "telemetry" }),
    prop("ecoNaviMode", "boolean", { mode: "telemetry" }),
    prop("iAutoMode", "boolean", { mode: "telemetry" }),
  ],
})
