import { defineConnector } from "@sixb/core"
import { createCelestrakClient } from "../lib/celestrak"

export const celestrak = defineConnector("celestrak", {
  type: "celestrak",
  connect: createCelestrakClient,
})
