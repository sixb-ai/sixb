import { defineSync } from "@sixb/core"
import { celestrak } from "../connectors/celestrak"
import { satelliteOrbit } from "../datasets/satellite-orbit"

export const syncSatelliteOrbit = defineSync("sync-satellite-orbit")
  .from(celestrak)
  .read(async (client, context) => {
    const orbit = await client.latestOrbit(context.signal)
    return [
      {
        id: "sentinel-6b",
        name: orbit.name,
        tleLine1: orbit.line1,
        tleLine2: orbit.line2,
        elementEpoch: orbit.elementEpoch,
      },
    ]
  })
  .intoDataset(satelliteOrbit)
