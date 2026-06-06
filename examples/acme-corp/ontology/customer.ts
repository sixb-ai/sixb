import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Employee } from "./employee"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  description: "A company customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string", { required: true }),
    prop("company", "string", { required: true }),
    prop("industry", "string"),
    prop("tier", stringEnum(["bronze", "silver", "gold", "platinum"])),
  ],
  links: [link("accountManager", Employee, { cardinality: "one" })],
})
