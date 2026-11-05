import type { FleetioHttp } from "../http"
import type {
  FleetioFault,
  FleetioFaultCreateInput,
  FleetioFaultFilter,
  FleetioFaultSort,
  FleetioFaultSummary,
  FleetioFaultUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type FaultsResource = FleetioReadMethods<
  FleetioFaultSummary,
  FleetioFault,
  FleetioFaultFilter,
  FleetioFaultSort
> &
  FleetioWriteMethods<FleetioFaultCreateInput, FleetioFault, FleetioFaultUpdateInput>

export function faultsResource(http: FleetioHttp): FaultsResource {
  return {
    ...readMethods(http, "faults", "fault id"),
    ...writeMethods(http, "faults", "fault id"),
  }
}
