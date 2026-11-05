import type { FleetioHttp } from "../http"
import type {
  FleetioArchivedPartFilter,
  FleetioId,
  FleetioListOptions,
  FleetioPage,
  FleetioPart,
  FleetioPartCreated,
  FleetioPartCreateInput,
  FleetioPartFilter,
  FleetioPartSort,
  FleetioPartSummary,
  FleetioPartUpdateInput,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioListMethods,
  type FleetioWriteMethods,
  listMethods,
  writeMethods,
} from "./crud"

type ArchivedOptions = FleetioListOptions<FleetioArchivedPartFilter>

export interface FleetioPartGetOptions {
  /** Return each cross-reference member's stock per part location, keeping members with stock. */
  readonly withCrossReferenceMemberLocations?: boolean
  /** The part locations to read when `withCrossReferenceMemberLocations` is true. */
  readonly partLocationIds?: readonly number[]
}

export type PartsResource = FleetioListMethods<
  FleetioPartSummary,
  FleetioPartFilter,
  FleetioPartSort
> &
  FleetioWriteMethods<FleetioPartCreateInput, FleetioPartCreated, FleetioPartUpdateInput> & {
    get(id: FleetioId, options?: FleetioPartGetOptions): Promise<FleetioPart>
    /** `PATCH /parts/{id}/archive` */
    archive(id: FleetioId): Promise<void>
    /** `PATCH /parts/{id}/restore` */
    restore(id: FleetioId): Promise<void>
    /** `GET /parts/archived` */
    listArchived(options?: ArchivedOptions): Promise<FleetioPage<FleetioPartSummary>>
    listAllArchived(options?: ArchivedOptions): AsyncIterable<FleetioPartSummary>
  }

export function partsResource(http: FleetioHttp): PartsResource {
  const partPath = (id: FleetioId) => `parts/${pathId(id, "part id")}`
  const archived = listMethods<FleetioPartSummary, FleetioArchivedPartFilter>(
    http,
    "parts/archived"
  )

  return {
    ...listMethods(http, "parts"),
    ...writeMethods(http, "parts", "part id"),
    get(id, options) {
      return http.get(partPath(id), {
        with_cross_reference_member_locations: options?.withCrossReferenceMemberLocations,
        "part_location_id[]": options?.partLocationIds,
      })
    },
    archive: (id) => http.patch(`${partPath(id)}/archive`),
    restore: (id) => http.patch(`${partPath(id)}/restore`),
    listArchived: archived.list,
    listAllArchived: archived.listAll,
  }
}
