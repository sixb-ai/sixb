import type { FleetioHttp } from "../http"
import type { FleetioVmrsReasonForRepair } from "../types"

export interface VmrsReasonsForRepairResource {
  /** `GET /vmrs_reason_for_repairs`. Fleetio returns the whole list with no paging. */
  list(): Promise<readonly FleetioVmrsReasonForRepair[]>
}

export function vmrsReasonsForRepairResource(http: FleetioHttp): VmrsReasonsForRepairResource {
  return {
    list() {
      return http.get("vmrs_reason_for_repairs")
    },
  }
}
