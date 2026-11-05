import type { FleetioHttp } from "../http"
import type {
  FleetioContactMini,
  FleetioId,
  FleetioListOptions,
  FleetioPage,
  FleetioWatcherFilter,
  FleetioWatcherSort,
} from "../types"
import { pathId } from "../validation"
import { listMethods, searchMethods } from "./crud"

export type FleetioWatchableType =
  | "charging_entry"
  | "contact_renewal_reminder"
  | "equipment"
  | "expense_entry"
  | "fuel_entry"
  | "issue"
  | "purchase_order"
  | "service_entry"
  | "service_reminder"
  | "vehicle"
  | "vehicle_assignment"
  | "vehicle_renewal_reminder"
  | "vendor"
  | "work_order"

type WatcherOptions = FleetioListOptions<FleetioWatcherFilter, FleetioWatcherSort>

/** The contacts watching a record, addressed by the record's type and ID. */
export interface WatchersResource {
  list(
    type: FleetioWatchableType,
    id: FleetioId,
    options?: WatcherOptions
  ): Promise<FleetioPage<FleetioContactMini>>
  listAll(
    type: FleetioWatchableType,
    id: FleetioId,
    options?: WatcherOptions
  ): AsyncIterable<FleetioContactMini>
  /** `POST /watchers/{type}/{id}/search` */
  search(
    type: FleetioWatchableType,
    id: FleetioId,
    options?: WatcherOptions
  ): Promise<FleetioPage<FleetioContactMini>>
  searchAll(
    type: FleetioWatchableType,
    id: FleetioId,
    options?: WatcherOptions
  ): AsyncIterable<FleetioContactMini>
  /** `PUT /watchers/{type}/{id}/watch`. Watches the record as the API key's user. */
  watch(type: FleetioWatchableType, id: FleetioId): Promise<void>
  /** `PUT /watchers/{type}/{id}/unwatch`. Stops watching the record as the API key's user. */
  unwatch(type: FleetioWatchableType, id: FleetioId): Promise<void>
}

export function watchersResource(http: FleetioHttp): WatchersResource {
  const path = (type: FleetioWatchableType, id: FleetioId) =>
    `watchers/${pathId(type, "watchable type")}/${pathId(id, "watchable id")}`
  const lists = (type: FleetioWatchableType, id: FleetioId) =>
    listMethods<FleetioContactMini, FleetioWatcherFilter, FleetioWatcherSort>(http, path(type, id))
  const searches = (type: FleetioWatchableType, id: FleetioId) =>
    searchMethods<FleetioContactMini, FleetioWatcherFilter, FleetioWatcherSort>(
      http,
      `${path(type, id)}/search`
    )

  return {
    list: (type, id, options) => lists(type, id).list(options),
    listAll: (type, id, options) => lists(type, id).listAll(options),
    search: (type, id, options) => searches(type, id).search(options),
    searchAll: (type, id, options) => searches(type, id).searchAll(options),
    watch: (type, id) => http.put(`${path(type, id)}/watch`),
    unwatch: (type, id) => http.put(`${path(type, id)}/unwatch`),
  }
}
