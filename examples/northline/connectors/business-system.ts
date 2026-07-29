import { defineConnector } from "@sixb/core"
import { createBusinessSystemClient } from "../lib/sources/business-system-client"

export const businessSystemConnector = defineConnector("business-system", {
  type: "northline-file-backed-business-system",
  connect: createBusinessSystemClient,
})
