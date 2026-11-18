import { defineSync } from "@sixb/core"
import { businessSystemConnector } from "../../connectors/business-system"
import { businessCustomers } from "../../datasets/business-system/customers"
import { allRows } from "../../lib/sources/client-utils"
import { hourlyBusinessSync } from "../../schedules/source-syncs"

export const syncBusinessCustomers = defineSync("sync-business-customers")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read((client) => allRows((input) => client.listCustomers(input)))
  .intoDataset(businessCustomers)
