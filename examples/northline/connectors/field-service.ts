import { defineConnector } from "@sixb/core"
import { createFieldServiceClient } from "../lib/sources/field-service-client"

export const fieldServiceConnector = defineConnector("field-service", {
  type: "northline-file-backed-field-service",
  connect: createFieldServiceClient,
})
