import { defineSync } from "@sixb/core"
import { fieldServiceConnector } from "../connectors/field-service"
import {
  fieldNotes,
  fieldTechnicians,
  fieldVisits,
  fieldWorkOrders,
} from "../datasets/field-service"
import { allRows } from "../lib/sources/client-utils"
import { frequentFieldSync } from "../schedules/source-syncs"

export const syncFieldTechnicians = defineSync("sync-field-technicians")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read((client) => allRows((input) => client.listTechnicians(input)))
  .intoDataset(fieldTechnicians)

export const syncFieldWorkOrders = defineSync("sync-field-work-orders")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read((client) => allRows((input) => client.listWorkOrders(input)))
  .intoDataset(fieldWorkOrders)

export const syncFieldVisits = defineSync("sync-field-visits")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read((client) => allRows((input) => client.listVisits(input)))
  .intoDataset(fieldVisits)

export const syncFieldNotes = defineSync("sync-field-notes")
  .when(frequentFieldSync)
  .from(fieldServiceConnector)
  .read((client) => allRows((input) => client.listFieldNotes(input)))
  .intoDataset(fieldNotes)
