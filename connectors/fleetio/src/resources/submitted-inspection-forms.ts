import type { FleetioHttp } from "../http"
import type {
  FleetioSubmittedInspectionForm,
  FleetioSubmittedInspectionFormFilter,
  FleetioSubmittedInspectionFormSort,
  FleetioSubmittedInspectionFormSummary,
} from "../types"
import { pathId } from "../validation"
import { type FleetioDeleteMethod, type FleetioReadMethods, readMethods } from "./crud"

/** Submitted inspections. Fleetio does not accept new submissions through its API. */
export type SubmittedInspectionFormsResource = FleetioReadMethods<
  FleetioSubmittedInspectionFormSummary,
  FleetioSubmittedInspectionForm,
  FleetioSubmittedInspectionFormFilter,
  FleetioSubmittedInspectionFormSort
> &
  FleetioDeleteMethod

export function submittedInspectionFormsResource(
  http: FleetioHttp
): SubmittedInspectionFormsResource {
  return {
    ...readMethods(http, "submitted_inspection_forms", "submitted inspection form id"),
    delete(id) {
      return http.delete(`submitted_inspection_forms/${pathId(id, "submitted inspection form id")}`)
    },
  }
}
