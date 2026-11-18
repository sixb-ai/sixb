import { defineSync } from "@sixb/core"
import { businessSystemConnector } from "../../connectors/business-system"
import { businessFacilities } from "../../datasets/business-system/facilities"
import { allRows } from "../../lib/sources/client-utils"
import { hourlyBusinessSync } from "../../schedules/source-syncs"

export const syncBusinessFacilities = defineSync("sync-business-facilities")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read((client) => allRows((input) => client.listFacilities(input)))
  .intoDataset(businessFacilities)
