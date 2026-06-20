import { defineAction } from "@sixb/core"
import { AccessRequest } from "../ontology/access-request"

export const resolveAccessRequest = defineAction("resolve-access-request", {
  description: "Resolve an access request.",
})
  .on(AccessRequest)
  .params({})
  .edits(() => {})
