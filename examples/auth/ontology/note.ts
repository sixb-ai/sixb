import { defineObjectType, prop } from "@pario/core"

// A single trivial object type so the signed-in app has something to render.
export const Note = defineObjectType({
  id: "note",
  name: "Note",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("body", "string"),
  ],
})
