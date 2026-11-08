import { change, defineSync } from "@sixb/core"
import { businessSystemConnector } from "../connectors/business-system"
import {
  businessContracts,
  businessCustomers,
  businessFacilities,
  businessQuotes,
} from "../datasets/business-system"
import { allRows } from "../lib/sources/client-utils"
import { hourlyBusinessSync } from "../schedules/source-syncs"

export const syncBusinessCustomers = defineSync("sync-business-customers")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read((client) => allRows((input) => client.listCustomers(input)))
  .intoDataset(businessCustomers)

export const syncBusinessFacilities = defineSync("sync-business-facilities")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read((client) => allRows((input) => client.listFacilities(input)))
  .intoDataset(businessFacilities)

export const syncBusinessContracts = defineSync("sync-business-contracts")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read((client) => allRows((input) => client.listContracts(input)))
  .intoDataset(businessContracts)

export const syncBusinessQuotes = defineSync("sync-business-quotes", { mode: "merge" })
  .when(hourlyBusinessSync)
  .checkpoint<{ cursor: string }>()
  .from(businessSystemConnector)
  .read(async function* (client, context) {
    for (const event of await client.quoteChangesSince(context.checkpoint?.cursor)) {
      yield event.kind === "delete" ? change.delete(event.key) : change.upsert(event.row)
      context.setCheckpoint({ cursor: event.cursor })
    }
  })
  .intoDataset(businessQuotes)
