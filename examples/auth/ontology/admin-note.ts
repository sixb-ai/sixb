import { defineObjectType, prop } from "@sixb/core"

// Restricted object type used by the auth example to prove Atlas object
// listings are narrowed by authorization grants.
export const AdminNote = defineObjectType({
  id: "admin-note",
  name: "Admin Note",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("body", "string"),
  ],
})
