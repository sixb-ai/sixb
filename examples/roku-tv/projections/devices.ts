import type { ObjectProjectionDefinition } from "@sixb/core"
import { defineProjection } from "@sixb/core"
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

export const rokuPowerStateProjection = defineProjection(
  "roku-power-state",
  Television.p.powerState
)
  .fromDataset(rokuDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "powerState" })

export const rokuActiveAppProjection = defineProjection("roku-active-app", Television.p.activeApp)
  .fromDataset(rokuDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "activeApp" })

export const rokuMediaStateProjection = defineProjection(
  "roku-media-state",
  Television.p.mediaState
)
  .fromDataset(rokuDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "mediaState" })

export const rokuLastSeenAtProjection = defineProjection(
  "roku-last-seen-at",
  Television.p.lastSeenAt
)
  .fromDataset(rokuDeviceSnapshots)
  .points({ objectId: "id", at: "observedAt", value: "observedAt" })
