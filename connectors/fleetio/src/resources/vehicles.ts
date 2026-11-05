import type { FleetioHttp } from "../http"
import type {
  FleetioArchivedVehicleFilter,
  FleetioArchivedVehicleSort,
  FleetioFuelEntrySummary,
  FleetioId,
  FleetioLinkedVehicleFilter,
  FleetioLinkedVehicleSort,
  FleetioListOptions,
  FleetioMeterEntrySummary,
  FleetioPage,
  FleetioPurchaseDetail,
  FleetioVehicle,
  FleetioVehicleAssignment,
  FleetioVehicleAssignmentOnVehicleFilter,
  FleetioVehicleAssignmentOnVehicleSort,
  FleetioVehicleAssignmentOnVehicleSummary,
  FleetioVehicleCreateInput,
  FleetioVehicleFilter,
  FleetioVehicleFuelEntryFilter,
  FleetioVehicleFuelEntrySort,
  FleetioVehicleIssueFilter,
  FleetioVehicleIssueSort,
  FleetioVehicleIssueSummary,
  FleetioVehicleMeterEntryFilter,
  FleetioVehicleMeterEntrySort,
  FleetioVehicleMini,
  FleetioVehicleServiceEntryFilter,
  FleetioVehicleServiceEntrySort,
  FleetioVehicleServiceEntrySummary,
  FleetioVehicleSort,
  FleetioVehicleSummary,
  FleetioVehicleUpdateInput,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioReadMethods,
  type FleetioSearchMethods,
  type FleetioWriteMethods,
  listMethods,
  readMethods,
  searchMethods,
  writeMethods,
} from "./crud"

type ArchivedOptions = FleetioListOptions<FleetioArchivedVehicleFilter, FleetioArchivedVehicleSort>

/** A list scoped to one vehicle: a page of records, or every record across pages. */
export type FleetioVehicleList<TItem, TFilter, TSort> = (
  vehicleId: FleetioId,
  options?: FleetioListOptions<TFilter, TSort>
) => Promise<FleetioPage<TItem>>

/** The same list as an iterator over every page. */
export type FleetioVehicleListAll<TItem, TFilter, TSort> = (
  vehicleId: FleetioId,
  options?: FleetioListOptions<TFilter, TSort>
) => AsyncIterable<TItem>

/**
 * Vehicles. `get` and the sub-lists also accept a VIN, plate or other external ID where the account
 * has set that up.
 */
export type VehiclesResource = FleetioReadMethods<
  FleetioVehicleSummary,
  FleetioVehicle,
  FleetioVehicleFilter,
  FleetioVehicleSort
> &
  FleetioWriteMethods<
    FleetioVehicleCreateInput,
    FleetioVehicle,
    FleetioVehicleUpdateInput,
    FleetioVehicle
  > &
  FleetioSearchMethods<FleetioVehicleSummary, FleetioVehicleFilter, FleetioVehicleSort> & {
    /** `PATCH /vehicles/{id}/archive` */
    archive(id: FleetioId): Promise<void>
    /** `PATCH /vehicles/{id}/restore` */
    restore(id: FleetioId): Promise<void>
    /** `GET /vehicles/archived` */
    listArchived(options?: ArchivedOptions): Promise<FleetioPage<FleetioVehicleSummary>>
    listAllArchived(options?: ArchivedOptions): AsyncIterable<FleetioVehicleSummary>
    /** `POST /vehicles/archived/search` */
    searchArchived(options?: ArchivedOptions): Promise<FleetioPage<FleetioVehicleSummary>>
    searchAllArchived(options?: ArchivedOptions): AsyncIterable<FleetioVehicleSummary>
    /** `GET /vehicles/{id}/current_assignment` */
    getCurrentAssignment(id: FleetioId): Promise<FleetioVehicleAssignment>
    /** `GET /vehicles/{id}/purchase_detail` */
    getPurchaseDetail(id: FleetioId): Promise<FleetioPurchaseDetail>
    /** `GET /vehicles/{vehicle_id}/fuel_entries` */
    listFuelEntries: FleetioVehicleList<
      FleetioFuelEntrySummary,
      FleetioVehicleFuelEntryFilter,
      FleetioVehicleFuelEntrySort
    >
    listAllFuelEntries: FleetioVehicleListAll<
      FleetioFuelEntrySummary,
      FleetioVehicleFuelEntryFilter,
      FleetioVehicleFuelEntrySort
    >
    /** `GET /vehicles/{id}/meter_entries` */
    listMeterEntries: FleetioVehicleList<
      FleetioMeterEntrySummary,
      FleetioVehicleMeterEntryFilter,
      FleetioVehicleMeterEntrySort
    >
    listAllMeterEntries: FleetioVehicleListAll<
      FleetioMeterEntrySummary,
      FleetioVehicleMeterEntryFilter,
      FleetioVehicleMeterEntrySort
    >
    /** `GET /vehicles/{id}/service_entries` */
    listServiceEntries: FleetioVehicleList<
      FleetioVehicleServiceEntrySummary,
      FleetioVehicleServiceEntryFilter,
      FleetioVehicleServiceEntrySort
    >
    listAllServiceEntries: FleetioVehicleListAll<
      FleetioVehicleServiceEntrySummary,
      FleetioVehicleServiceEntryFilter,
      FleetioVehicleServiceEntrySort
    >
    /** `GET /vehicles/{id}/vehicle_assignments` */
    listAssignments: FleetioVehicleList<
      FleetioVehicleAssignmentOnVehicleSummary,
      FleetioVehicleAssignmentOnVehicleFilter,
      FleetioVehicleAssignmentOnVehicleSort
    >
    listAllAssignments: FleetioVehicleListAll<
      FleetioVehicleAssignmentOnVehicleSummary,
      FleetioVehicleAssignmentOnVehicleFilter,
      FleetioVehicleAssignmentOnVehicleSort
    >
    /** `GET /vehicles/{id}/issues` */
    listIssues: FleetioVehicleList<
      FleetioVehicleIssueSummary,
      FleetioVehicleIssueFilter,
      FleetioVehicleIssueSort
    >
    listAllIssues: FleetioVehicleListAll<
      FleetioVehicleIssueSummary,
      FleetioVehicleIssueFilter,
      FleetioVehicleIssueSort
    >
    /** `GET /vehicles/{id}/linked_vehicles` */
    listLinkedVehicles: FleetioVehicleList<
      FleetioVehicleMini,
      FleetioLinkedVehicleFilter,
      FleetioLinkedVehicleSort
    >
    listAllLinkedVehicles: FleetioVehicleListAll<
      FleetioVehicleMini,
      FleetioLinkedVehicleFilter,
      FleetioLinkedVehicleSort
    >
  }

export function vehiclesResource(http: FleetioHttp): VehiclesResource {
  const vehiclePath = (id: FleetioId) => `vehicles/${pathId(id, "vehicle id")}`
  const archived = listMethods<
    FleetioVehicleSummary,
    FleetioArchivedVehicleFilter,
    FleetioArchivedVehicleSort
  >(http, "vehicles/archived")
  const archivedSearch = searchMethods<
    FleetioVehicleSummary,
    FleetioArchivedVehicleFilter,
    FleetioArchivedVehicleSort
  >(http, "vehicles/archived/search")

  function subList<TItem, TFilter, TSort>(child: string) {
    const lists = (id: FleetioId) =>
      listMethods<TItem, TFilter, TSort>(http, `${vehiclePath(id)}/${child}`)

    return {
      list: ((id, options) => lists(id).list(options)) as FleetioVehicleList<TItem, TFilter, TSort>,
      listAll: ((id, options) => lists(id).listAll(options)) as FleetioVehicleListAll<
        TItem,
        TFilter,
        TSort
      >,
    }
  }

  const fuelEntries = subList<
    FleetioFuelEntrySummary,
    FleetioVehicleFuelEntryFilter,
    FleetioVehicleFuelEntrySort
  >("fuel_entries")
  const meterEntries = subList<
    FleetioMeterEntrySummary,
    FleetioVehicleMeterEntryFilter,
    FleetioVehicleMeterEntrySort
  >("meter_entries")
  const serviceEntries = subList<
    FleetioVehicleServiceEntrySummary,
    FleetioVehicleServiceEntryFilter,
    FleetioVehicleServiceEntrySort
  >("service_entries")
  const assignments = subList<
    FleetioVehicleAssignmentOnVehicleSummary,
    FleetioVehicleAssignmentOnVehicleFilter,
    FleetioVehicleAssignmentOnVehicleSort
  >("vehicle_assignments")
  const issues = subList<
    FleetioVehicleIssueSummary,
    FleetioVehicleIssueFilter,
    FleetioVehicleIssueSort
  >("issues")
  const linkedVehicles = subList<
    FleetioVehicleMini,
    FleetioLinkedVehicleFilter,
    FleetioLinkedVehicleSort
  >("linked_vehicles")

  return {
    ...readMethods(http, "vehicles", "vehicle id"),
    ...writeMethods(http, "vehicles", "vehicle id"),
    ...searchMethods(http, "vehicles/search"),
    archive: (id) => http.patch(`${vehiclePath(id)}/archive`),
    restore: (id) => http.patch(`${vehiclePath(id)}/restore`),
    listArchived: archived.list,
    listAllArchived: archived.listAll,
    searchArchived: archivedSearch.search,
    searchAllArchived: archivedSearch.searchAll,
    getCurrentAssignment: (id) => http.get(`${vehiclePath(id)}/current_assignment`),
    getPurchaseDetail: (id) => http.get(`${vehiclePath(id)}/purchase_detail`),
    listFuelEntries: fuelEntries.list,
    listAllFuelEntries: fuelEntries.listAll,
    listMeterEntries: meterEntries.list,
    listAllMeterEntries: meterEntries.listAll,
    listServiceEntries: serviceEntries.list,
    listAllServiceEntries: serviceEntries.listAll,
    listAssignments: assignments.list,
    listAllAssignments: assignments.listAll,
    listIssues: issues.list,
    listAllIssues: issues.listAll,
    listLinkedVehicles: linkedVehicles.list,
    listAllLinkedVehicles: linkedVehicles.listAll,
  }
}
