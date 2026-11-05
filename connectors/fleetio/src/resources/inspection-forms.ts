import type { FleetioHttp } from "../http"
import type {
  FleetioInspectionForm,
  FleetioInspectionFormFilter,
  FleetioInspectionFormSort,
  FleetioInspectionFormSummary,
} from "../types"
import { type FleetioReadMethods, readMethods } from "./crud"

/** Inspection forms. Fleetio only creates them in its web app. */
export type InspectionFormsResource = FleetioReadMethods<
  FleetioInspectionFormSummary,
  FleetioInspectionForm,
  FleetioInspectionFormFilter,
  FleetioInspectionFormSort
>

export function inspectionFormsResource(http: FleetioHttp): InspectionFormsResource {
  return readMethods(http, "inspection_forms", "inspection form id")
}
