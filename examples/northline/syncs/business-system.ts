import { defineSync } from "@sixb/core"
import { businessSystemConnector } from "../connectors/business-system"
import {
  businessContracts,
  businessCustomers,
  businessFacilities,
  businessQuotes,
} from "../datasets/business-system"
import { hourlyBusinessSync } from "../schedules/source-syncs"

export const syncBusinessCustomers = defineSync("sync-business-customers")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read(async (client) => (await client.listCustomers()).rows)
  .intoDataset(businessCustomers)

export const syncBusinessFacilities = defineSync("sync-business-facilities")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read(async (client) => (await client.listFacilities()).rows)
  .intoDataset(businessFacilities)

export const syncBusinessContracts = defineSync("sync-business-contracts")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read(async (client) => (await client.listContracts()).rows)
  .intoDataset(businessContracts)

export const syncBusinessQuotes = defineSync("sync-business-quotes")
  .when(hourlyBusinessSync)
  .from(businessSystemConnector)
  .read(async (client) => (await client.listQuotes()).rows)
  .intoDataset(businessQuotes)
