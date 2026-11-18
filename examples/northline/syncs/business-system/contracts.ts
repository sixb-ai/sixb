import { defineSync } from "@sixb/core"
import { businessSystemConnector } from "../../connectors/business-system"
import { businessContracts } from "../../datasets/business-system/contracts"
import { allRows } from "../../lib/sources/client-utils"
import { hourlyBusinessSync } from "../../schedules/source-syncs"

export const syncBusinessContracts = defineSync("sync-business-contracts")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read((client) => allRows((input) => client.listContracts(input)))
  .intoDataset(businessContracts)
