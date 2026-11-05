import type { FleetioHttp } from "../http"
import type {
  FleetioPartLocation,
  FleetioPartLocationFilter,
  FleetioPartLocationSort,
} from "../types"
import { type FleetioListMethods, listMethods } from "./crud"

export type PartLocationsResource = FleetioListMethods<
  FleetioPartLocation,
  FleetioPartLocationFilter,
  FleetioPartLocationSort
>

export function partLocationsResource(http: FleetioHttp): PartLocationsResource {
  return listMethods(http, "part_locations")
}
