import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Department } from "./department"

export const Employee = defineObjectType({
  id: "Employee",
  name: "Employee",
  description: "A company employee.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string", { required: true }),
    prop("role", "string", { required: true }),
    prop("seniority", stringEnum(["junior", "mid", "senior", "lead", "director"])),
    prop("hireDate", "date"),
    prop("departmentRef", "string"),
  ],
  links: [link("department", Department, { cardinality: "one" })],
})
