import type { FleetioHttp } from "../http"
import type {
  FleetioFuelEntry,
  FleetioFuelEntryCreateInput,
  FleetioFuelEntryFilter,
  FleetioFuelEntrySort,
  FleetioFuelEntrySummary,
  FleetioFuelEntryUpdateInput,
  FleetioFuelEntryWriteResult,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type FuelEntriesResource = FleetioReadMethods<
  FleetioFuelEntrySummary,
  FleetioFuelEntry,
  FleetioFuelEntryFilter,
  FleetioFuelEntrySort
> &
  FleetioWriteMethods<
    FleetioFuelEntryCreateInput,
    FleetioFuelEntryWriteResult,
    FleetioFuelEntryUpdateInput,
    FleetioFuelEntryWriteResult
  >

export function fuelEntriesResource(http: FleetioHttp): FuelEntriesResource {
  return {
    ...readMethods(http, "fuel_entries", "fuel entry id"),
    ...writeMethods(http, "fuel_entries", "fuel entry id"),
  }
}
