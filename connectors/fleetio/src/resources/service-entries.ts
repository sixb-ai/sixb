import type { FleetioHttp } from "../http"
import type {
  FleetioServiceEntry,
  FleetioServiceEntryCreateInput,
  FleetioServiceEntryFilter,
  FleetioServiceEntrySort,
  FleetioServiceEntrySummary,
  FleetioServiceEntryUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type ServiceEntriesResource = FleetioReadMethods<
  FleetioServiceEntrySummary,
  FleetioServiceEntry,
  FleetioServiceEntryFilter,
  FleetioServiceEntrySort
> &
  FleetioWriteMethods<
    FleetioServiceEntryCreateInput,
    FleetioServiceEntry,
    FleetioServiceEntryUpdateInput
  >

export function serviceEntriesResource(http: FleetioHttp): ServiceEntriesResource {
  return {
    ...readMethods(http, "service_entries", "service entry id"),
    ...writeMethods(http, "service_entries", "service entry id"),
  }
}
