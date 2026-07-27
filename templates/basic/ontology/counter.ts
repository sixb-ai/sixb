import { defineObjectType, prop } from "@sixb/core"

export const Counter = defineObjectType({
  id: "Counter",
  name: "Counter",
  description: "A simple counter advanced through an action.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("value", "integer", { required: true }),
  ],
})
