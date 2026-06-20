import { defineObjectType, prop } from "@sixb/core"

export const AccessRequest = defineObjectType({
  id: "access-request",
  name: "Access Request",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("requesterEmail", "string", { required: true }),
    prop("reason", "string"),
    prop("status", "string", { required: true }),
  ],
})
