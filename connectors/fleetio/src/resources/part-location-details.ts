import type { FleetioHttp } from "../http"
import type {
  FleetioId,
  FleetioInventorySet,
  FleetioListOptions,
  FleetioPage,
  FleetioPartInventorySetFilter,
  FleetioPartInventorySetSort,
  FleetioPartLocationDetail,
  FleetioPartLocationDetailFilter,
  FleetioPartLocationDetailSort,
} from "../types"
import { pathId } from "../validation"
import { type FleetioListMethods, listMethods } from "./crud"

type InventorySetOptions = FleetioListOptions<
  FleetioPartInventorySetFilter,
  FleetioPartInventorySetSort
>

export type PartLocationDetailsResource = FleetioListMethods<
  FleetioPartLocationDetail,
  FleetioPartLocationDetailFilter,
  FleetioPartLocationDetailSort
> & {
  /** `GET /part_location_details/{id}/inventory_sets` */
  listInventorySets(
    id: FleetioId,
    options?: InventorySetOptions
  ): Promise<FleetioPage<FleetioInventorySet>>
  listAllInventorySets(
    id: FleetioId,
    options?: InventorySetOptions
  ): AsyncIterable<FleetioInventorySet>
}

export function partLocationDetailsResource(http: FleetioHttp): PartLocationDetailsResource {
  const inventorySets = (id: FleetioId) =>
    listMethods<FleetioInventorySet, FleetioPartInventorySetFilter, FleetioPartInventorySetSort>(
      http,
      `part_location_details/${pathId(id, "part location detail id")}/inventory_sets`
    )

  return {
    ...listMethods(http, "part_location_details"),
    listInventorySets: (id, options) => inventorySets(id).list(options),
    listAllInventorySets: (id, options) => inventorySets(id).listAll(options),
  }
}
