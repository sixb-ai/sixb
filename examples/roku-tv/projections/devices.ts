import type { ObjectProjectionDefinition } from "@sixb/core"
import { defineProjection, defineTelemetryProjection } from "@sixb/core"
import { rokuDeviceSnapshots } from "../datasets/deviceSnapshots"
import { Television } from "../ontology/television"

export const rokuDevicesProjection: ObjectProjectionDefinition = defineProjection(
  "roku-devices",
  Television
)
  .fromDataset(rokuDeviceSnapshots)
  .properties({
    id: "id",
    name: "name",
    platform: "platform",
    controlHost: "controlHost",
    manufacturer: "manufacturer",
    modelName: "modelName",
    modelNumber: "modelNumber",
    serialNumber: "serialNumber",
    softwareVersion: "softwareVersion",
  })

export const rokuPowerStateProjection = defineTelemetryProjection(
  "roku-power-state",
  Television.p.powerState
)
  .fromDataset(rokuDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "powerState" })

export const rokuActiveAppProjection = defineTelemetryProjection(
  "roku-active-app",
  Television.p.activeApp
)
  .fromDataset(rokuDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "activeApp" })

export const rokuMediaStateProjection = defineTelemetryProjection(
  "roku-media-state",
  Television.p.mediaState
)
  .fromDataset(rokuDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "mediaState" })

export const rokuLastSeenAtProjection = defineTelemetryProjection(
  "roku-last-seen-at",
  Television.p.lastSeenAt
)
  .fromDataset(rokuDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "observedAt" })
