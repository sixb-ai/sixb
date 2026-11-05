import type { FleetioHttp } from "../http"
import type {
  FleetioMeterEntry,
  FleetioMeterEntryCreated,
  FleetioMeterEntryCreateInput,
  FleetioMeterEntryFilter,
  FleetioMeterEntrySort,
  FleetioMeterEntrySummary,
  FleetioMeterEntryUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type MeterEntriesResource = FleetioReadMethods<
  FleetioMeterEntrySummary,
  FleetioMeterEntry,
  FleetioMeterEntryFilter,
  FleetioMeterEntrySort
> &
  FleetioWriteMethods<
    FleetioMeterEntryCreateInput,
    FleetioMeterEntryCreated,
    FleetioMeterEntryUpdateInput
  >

export function meterEntriesResource(http: FleetioHttp): MeterEntriesResource {
  return {
    ...readMethods(http, "meter_entries", "meter entry id"),
    ...writeMethods(http, "meter_entries", "meter entry id"),
  }
}
