import { defineSync } from "@sixb/core"
import { fieldServiceConnector } from "../../connectors/field-service"
import { fieldVisits } from "../../datasets/field-service/visits"
import { allRows } from "../../lib/sources/client-utils"
import { frequentFieldSync } from "../../schedules/source-syncs"

export const syncFieldVisits = defineSync("sync-field-visits")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read((client) => allRows((input) => client.listVisits(input)))
  .intoDataset(fieldVisits)
