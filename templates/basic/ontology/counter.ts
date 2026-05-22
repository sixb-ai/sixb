import { defineObjectType, prop } from "@pario/core"

export const Counter = defineObjectType({
  id: "Counter",
  name: "Counter",
  description: "A simple counter with a ticking value.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("value", "integer", { mode: "telemetry" }),
  ],
})
