import type { FleetioHttp } from "../http"
import type {
  FleetioLabel,
  FleetioLabelCreateInput,
  FleetioLabelFilter,
  FleetioLabelSort,
} from "../types"
import { type FleetioCreateMethod, type FleetioListMethods, listMethods } from "./crud"

export type LabelsResource = FleetioListMethods<
  FleetioLabel,
  FleetioLabelFilter,
  FleetioLabelSort
> &
  FleetioCreateMethod<FleetioLabelCreateInput, FleetioLabel>

export function labelsResource(http: FleetioHttp): LabelsResource {
  return {
    ...listMethods(http, "labels"),
    create(input) {
      return http.post("labels", input)
    },
  }
}
