import { defineSync } from "@sixb/core"
import { fieldServiceConnector } from "../../connectors/field-service"
import { fieldWorkOrders } from "../../datasets/field-service/work-orders"
import { allRows } from "../../lib/sources/client-utils"
import { frequentFieldSync } from "../../schedules/source-syncs"

export const syncFieldWorkOrders = defineSync("sync-field-work-orders")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read((client) => allRows((input) => client.listWorkOrders(input)))
  .intoDataset(fieldWorkOrders)
