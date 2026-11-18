import { defineSync } from "@sixb/core"
import { fieldServiceConnector } from "../../connectors/field-service"
import { fieldTechnicians } from "../../datasets/field-service/technicians"
import { allRows } from "../../lib/sources/client-utils"
import { frequentFieldSync } from "../../schedules/source-syncs"

export const syncFieldTechnicians = defineSync("sync-field-technicians")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read((client) => allRows((input) => client.listTechnicians(input)))
  .intoDataset(fieldTechnicians)
