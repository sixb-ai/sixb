import { defineSync } from "@sixb/core"
import { fieldServiceConnector } from "../../connectors/field-service"
import { fieldNotes } from "../../datasets/field-service/notes"
import { allRows } from "../../lib/sources/client-utils"
import { frequentFieldSync } from "../../schedules/source-syncs"

export const syncFieldNotes = defineSync("sync-field-notes")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read((client) => allRows((input) => client.listFieldNotes(input)))
  .intoDataset(fieldNotes)
