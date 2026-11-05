import type { FleetioHttp } from "../http"
import type {
  FleetioArchivedVendorFilter,
  FleetioId,
  FleetioListOptions,
  FleetioPage,
  FleetioVendor,
  FleetioVendorCreateInput,
  FleetioVendorFilter,
  FleetioVendorSort,
  FleetioVendorSummary,
  FleetioVendorUpdateInput,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  listMethods,
  readMethods,
  writeMethods,
} from "./crud"

type ArchivedOptions = FleetioListOptions<FleetioArchivedVendorFilter>

export type VendorsResource = FleetioReadMethods<
  FleetioVendorSummary,
  FleetioVendor,
  FleetioVendorFilter,
  FleetioVendorSort
> &
  FleetioWriteMethods<
    FleetioVendorCreateInput,
    FleetioVendor,
    FleetioVendorUpdateInput,
    FleetioVendor
  > & {
    /** `PATCH /vendors/{id}/archive` */
    archive(id: FleetioId): Promise<void>
    /** `PATCH /vendors/{id}/restore` */
    restore(id: FleetioId): Promise<void>
    /** `GET /vendors/archived` */
    listArchived(options?: ArchivedOptions): Promise<FleetioPage<FleetioVendorSummary>>
    listAllArchived(options?: ArchivedOptions): AsyncIterable<FleetioVendorSummary>
  }

export function vendorsResource(http: FleetioHttp): VendorsResource {
  const vendorPath = (id: FleetioId) => `vendors/${pathId(id, "vendor id")}`
  const archived = listMethods<FleetioVendorSummary, FleetioArchivedVendorFilter>(
    http,
    "vendors/archived"
  )

  return {
    ...readMethods(http, "vendors", "vendor id"),
    ...writeMethods(http, "vendors", "vendor id"),
    archive: (id) => http.patch(`${vendorPath(id)}/archive`),
    restore: (id) => http.patch(`${vendorPath(id)}/restore`),
    listArchived: archived.list,
    listAllArchived: archived.listAll,
  }
}
