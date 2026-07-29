import { defineSync } from "@sixb/core"
import { fieldServiceConnector } from "../connectors/field-service"
import {
  fieldNotes,
  fieldTechnicians,
  fieldVisits,
  fieldWorkOrders,
} from "../datasets/field-service"
import { frequentFieldSync } from "../schedules/source-syncs"

export const syncFieldTechnicians = defineSync("sync-field-technicians")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read(async (client) => (await client.listTechnicians()).rows)
  .intoDataset(fieldTechnicians)

export const syncFieldWorkOrders = defineSync("sync-field-work-orders")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read(async (client) => (await client.listWorkOrders()).rows)
  .intoDataset(fieldWorkOrders)

export const syncFieldVisits = defineSync("sync-field-visits")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read(async (client) => (await client.listVisits()).rows)
  .intoDataset(fieldVisits)

export const syncFieldNotes = defineSync("sync-field-notes")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read(async (client) => (await client.listFieldNotes()).rows)
  .intoDataset(fieldNotes)
