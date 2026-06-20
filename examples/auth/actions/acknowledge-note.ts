import { defineAction } from "@sixb/core"
import { Note } from "../ontology/note"

export const acknowledgeNote = defineAction("acknowledge-note", {
  description: "Acknowledge that a team note was read.",
})
  .on(Note)
  .params({})
  .edits(() => {})
