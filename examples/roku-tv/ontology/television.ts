import { defineObjectType, prop } from "@sixb/core"
import { televisionObjectTypeId } from "../lib/televisionTwin"

export const Television = defineObjectType({
  id: televisionObjectTypeId,
  name: "Television",
  description: "A controllable television endpoint with runtime state telemetry.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("platform", "string", { required: true }),
    prop("controlHost", "string", { required: true }),
    prop("manufacturer", "string"),
    prop("modelName", "string"),
    prop("modelNumber", "string"),
    prop("serialNumber", "string"),
    prop("softwareVersion", "string"),
    prop("powerState", "string", { mode: "telemetry" }),
    prop("activeApp", "string", { mode: "telemetry", nullable: true }),
    prop("mediaState", "string", { mode: "telemetry", nullable: true }),
    prop("lastSeenAt", "timestamp", { mode: "telemetry" }),
  ],
})
