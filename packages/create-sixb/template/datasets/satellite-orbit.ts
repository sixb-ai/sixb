import { col, defineDataset } from "@sixb/core"

export const satelliteOrbit = defineDataset("satellite-orbit", {
  description: "Latest public orbital elements for Sentinel-6B.",
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("tleLine1", "string"),
    col("tleLine2", "string"),
    col("elementEpoch", "timestamp"),
  ],
})
